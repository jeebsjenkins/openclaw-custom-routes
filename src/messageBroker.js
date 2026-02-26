/**
 * messageBroker.js — Unified path-based message broker.
 *
 * Replaces both messageBus.js (agent-to-agent) and commsRouter.js (external inbound)
 * with a single routing system where everything is a path.
 *
 * Path addressing:
 *   agent/{id}                        — direct message to agent (auto-subscribed)
 *   agent/{parent}/**                 — agent subtree
 *   agent/*                           — all top-level agents
 *   slack/{workspace}/#{channel}      — Slack channel
 *   slack/{workspace}/@{user}         — Slack DM
 *   email/{to}@domain/{from}@domain   — email
 *   webhook/{service}/{topic}         — webhook
 *   {any}/{path}/{segments}           — custom
 *
 * Wildcard matching:
 *   *   — matches exactly one path segment
 *   **  — matches zero or more segments
 *
 * Every agent is auto-subscribed to agent/{its-own-id} (computed, not persisted).
 * Custom subscriptions are persisted in jvAgent.json under "subscriptions".
 * Unmatched messages go to .messages/broker-unmatched.jsonl.
 *
 * Message format:
 * {
 *   id: string,          // UUID
 *   from: string,        // sender (agent ID or system identifier)
 *   path: string,        // delivery path
 *   command: string,     // action verb
 *   payload: object,     // arbitrary data
 *   status: string,      // "pending" | "delivered" | "read"
 *   timestamp: number,   // Unix ms
 *   source: string,      // "internal" | "slack" | "email" | "webhook" | etc.
 *   externalId?: string  // external system message ID
 * }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * Create a MessageBroker instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory
 * @param {object} projectManager - ProjectManager instance (listAgents, getAgent, updateAgent)
 * @param {object} [log] - Logger with info/warn/error methods
 * @returns {object} MessageBroker API
 */
function createMessageBroker(projectRoot, projectManager, log = console) {
  if (!projectRoot) throw new Error('messageBroker: projectRoot is required');
  if (!projectManager) throw new Error('messageBroker: projectManager is required');

  const messagesDir = path.join(projectRoot, '.messages');
  fs.mkdirSync(messagesDir, { recursive: true });

  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);

  // Forward index: pattern → Set<agentId>  (custom subscriptions only)
  const subscriptionIndex = new Map();
  // Reverse index: agentId → Set<pattern>  (custom subscriptions only)
  const agentIndex = new Map();
  // Auto-subscriptions: agentId → pattern  (computed, not persisted)
  const autoSubs = new Map();

  // Build indexes on startup
  _rebuildIndex();

  // ─── Path Matching ──────────────────────────────────────────────────────

  /**
   * Test whether a pattern matches a path.
   */
  function pathMatches(pattern, inPath) {
    const patternSegs = _normalize(pattern).split('/');
    const pathSegs = _normalize(inPath).split('/');
    return _matchSegments(patternSegs, 0, pathSegs, 0);
  }

  function _matchSegments(pSegs, pi, tSegs, ti) {
    if (pi === pSegs.length && ti === tSegs.length) return true;
    if (pi === pSegs.length) return false;

    const seg = pSegs[pi];

    if (seg === '**') {
      for (let skip = ti; skip <= tSegs.length; skip++) {
        if (_matchSegments(pSegs, pi + 1, tSegs, skip)) return true;
      }
      return false;
    }

    if (ti === tSegs.length) return false;

    if (seg === '*') {
      return _matchSegments(pSegs, pi + 1, tSegs, ti + 1);
    }

    if (seg === tSegs[ti]) {
      return _matchSegments(pSegs, pi + 1, tSegs, ti + 1);
    }

    return false;
  }

  function _normalize(p) {
    return (p || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  }

  // ─── Core Routing ──────────────────────────────────────────────────────

  /**
   * Route a message to all subscribers matching the path.
   * This is the universal routing method.
   *
   * @param {string} from - Sender ID
   * @param {string} msgPath - Delivery path (e.g. "agent/researcher", "slack/workspace/#general")
   * @param {object} message - { command, payload, source?, externalId? }
   * @returns {object} { id, from, path, command, payload, status, timestamp, delivered, deliveredTo, messageIds, unmatched }
   */
  function route(from, msgPath, message = {}) {
    const normalizedPath = _normalize(msgPath);
    if (!normalizedPath) throw new Error('path is required');

    const msg = {
      id: crypto.randomUUID(),
      from,
      path: normalizedPath,
      command: message.command || 'message',
      payload: message.payload || {},
      status: 'pending',
      timestamp: Date.now(),
      source: message.source || 'internal',
      externalId: message.externalId || null,
    };

    // Find all agents with matching subscriptions (auto + custom)
    const matchedAgents = _findMatchingAgents(normalizedPath, from);

    if (matchedAgents.size === 0) {
      // Dead-letter
      _appendUnmatched({
        id: msg.id,
        from,
        path: normalizedPath,
        command: msg.command,
        payload: msg.payload,
        source: msg.source,
        externalId: msg.externalId,
        reason: 'no_subscribers',
        timestamp: msg.timestamp,
      });

      log.warn(`[messageBroker] No subscribers for: ${normalizedPath}`);
      return { ...msg, delivered: false, deliveredTo: [], messageIds: [], unmatched: true };
    }

    // Persist and deliver to each matched agent
    const deliveredTo = [];
    const messageIds = [];

    for (const agentId of matchedAgents) {
      // Create per-agent copy with the agent's path for persistence
      const agentMsg = { ...msg, _deliveredTo: agentId };

      // Persist to agent's message file
      _appendMessage(agentId, agentMsg);

      // Real-time delivery via EventEmitter
      emitter.emit(`agent:${agentId}`, agentMsg);

      deliveredTo.push(agentId);
      messageIds.push(msg.id);
    }

    log.info(`[messageBroker] ${from} → ${normalizedPath}: ${msg.command} → [${deliveredTo.join(', ')}] (${msg.id})`);
    return { ...msg, delivered: true, deliveredTo, messageIds, unmatched: false };
  }

  /**
   * Find all agents whose subscriptions (auto + custom) match a path.
   * Excludes the sender from broadcast-style matches.
   */
  function _findMatchingAgents(normalizedPath, from) {
    const matched = new Set();

    // Check auto-subscriptions (exact agent/{id} match)
    for (const [agentId, autoPattern] of autoSubs) {
      if (pathMatches(autoPattern, normalizedPath)) {
        matched.add(agentId);
      }
    }

    // Check custom subscriptions
    for (const [pattern, agents] of subscriptionIndex) {
      if (pathMatches(pattern, normalizedPath)) {
        for (const agentId of agents) {
          matched.add(agentId);
        }
      }
    }

    // For broadcast-style paths (agent/**), exclude the sender
    if (normalizedPath.startsWith('agent/') && from && matched.has(from)) {
      // Only exclude sender on wildcard/broadcast, not direct messages
      const isDirectToSender = normalizedPath === `agent/${from}`;
      if (!isDirectToSender) {
        matched.delete(from);
      }
    }

    return matched;
  }

  // ─── Convenience Methods ───────────────────────────────────────────────

  /**
   * Send a direct message to an agent (sugar for route to agent/{id}).
   */
  function send(from, toAgentId, message = {}) {
    return route(from, `agent/${toAgentId}`, message);
  }

  /**
   * Broadcast to all agents (sugar for route to agent/**).
   */
  function broadcast(from, message = {}) {
    return route(from, 'agent/**', message);
  }

  // ─── Receiving / Polling ───────────────────────────────────────────────

  /**
   * Get pending messages for an agent and mark them as delivered.
   */
  function receive(agentId) {
    if (!agentId) throw new Error('agentId is required');

    const filePath = _agentMessageFile(agentId);
    const entries = _readJSONL(filePath);
    const pending = entries.filter(m => m.status === 'pending');

    if (pending.length > 0) {
      const ids = new Set(pending.map(m => m.id));
      const updated = entries.map(e => ids.has(e.id) ? { ...e, status: 'delivered' } : e);
      const content = updated.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(filePath, content);
    }

    // Return with status updated
    return pending.map(m => ({ ...m, status: 'delivered' }));
  }

  // ─── Real-time Listening ───────────────────────────────────────────────

  /**
   * Subscribe to real-time messages for an agent.
   * Fires for direct messages to agent/{id} AND any broadcast.
   * Returns an unsubscribe function.
   */
  function listen(agentId, callback) {
    if (!agentId) throw new Error('agentId is required');

    const handler = (msg) => callback(msg);

    emitter.on(`agent:${agentId}`, handler);

    return () => {
      emitter.off(`agent:${agentId}`, handler);
    };
  }

  // ─── Subscription Management ───────────────────────────────────────────

  /**
   * Add a custom subscription for an agent. Persists to jvAgent.json.
   */
  function subscribe(agentId, pattern) {
    if (!agentId) throw new Error('agentId is required');
    if (!pattern) throw new Error('pattern is required');

    const normalized = _normalize(pattern);

    // Don't allow subscribing to own auto-subscription pattern
    if (normalized === `agent/${agentId}`) {
      return { success: true, pattern: normalized, note: 'auto-subscribed' };
    }

    // Forward index
    if (!subscriptionIndex.has(normalized)) {
      subscriptionIndex.set(normalized, new Set());
    }
    subscriptionIndex.get(normalized).add(agentId);

    // Reverse index
    if (!agentIndex.has(agentId)) {
      agentIndex.set(agentId, new Set());
    }
    agentIndex.get(agentId).add(normalized);

    // Persist
    _persistSubscriptions(agentId);

    log.info(`[messageBroker] ${agentId} subscribed to: ${normalized}`);
    return { success: true, pattern: normalized };
  }

  /**
   * Remove a custom subscription.
   */
  function unsubscribe(agentId, pattern) {
    if (!agentId) throw new Error('agentId is required');
    if (!pattern) throw new Error('pattern is required');

    const normalized = _normalize(pattern);

    // Can't unsub from auto-subscription
    if (normalized === `agent/${agentId}`) {
      throw new Error('Cannot unsubscribe from auto-subscription');
    }

    const agents = subscriptionIndex.get(normalized);
    if (agents) {
      agents.delete(agentId);
      if (agents.size === 0) subscriptionIndex.delete(normalized);
    }

    const patterns = agentIndex.get(agentId);
    if (patterns) {
      patterns.delete(normalized);
      if (patterns.size === 0) agentIndex.delete(agentId);
    }

    _persistSubscriptions(agentId);

    log.info(`[messageBroker] ${agentId} unsubscribed from: ${normalized}`);
    return { success: true, pattern: normalized };
  }

  /**
   * Get custom subscriptions for an agent (excludes auto-subscription).
   */
  function getSubscriptions(agentId) {
    if (!agentId) throw new Error('agentId is required');

    const patterns = agentIndex.get(agentId);
    if (!patterns || patterns.size === 0) return [];

    try {
      const agent = projectManager.getAgent(agentId);
      const subs = agent.subscriptions || [];
      const patternSet = new Set(patterns);
      return subs.filter(s => patternSet.has(s.pattern));
    } catch {
      return [...patterns].map(p => ({ pattern: p, addedAt: null }));
    }
  }

  // ─── History ───────────────────────────────────────────────────────────

  /**
   * Read message history for an agent (messages delivered to this agent).
   */
  function history(agentId, options = {}) {
    const { limit = 100, fromTime, toTime } = options;

    // Read agent's own message file
    const filePath = _agentMessageFile(agentId);
    let entries = _readJSONL(filePath);

    if (fromTime) entries = entries.filter(e => e.timestamp >= fromTime);
    if (toTime) entries = entries.filter(e => e.timestamp <= toTime);

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  // ─── Dead-letter / Unmatched ───────────────────────────────────────────

  function getUnmatched(options = {}) {
    const { limit = 100, fromTime, toTime } = options;
    const filePath = path.join(messagesDir, 'broker-unmatched.jsonl');
    let entries = _readJSONL(filePath);

    if (fromTime) entries = entries.filter(e => e.timestamp >= fromTime);
    if (toTime) entries = entries.filter(e => e.timestamp <= toTime);

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
  }

  function clearUnmatched() {
    const filePath = path.join(messagesDir, 'broker-unmatched.jsonl');
    try {
      fs.writeFileSync(filePath, '');
      return { cleared: true };
    } catch {
      return { cleared: false };
    }
  }

  // ─── Index Management ──────────────────────────────────────────────────

  function _rebuildIndex() {
    subscriptionIndex.clear();
    agentIndex.clear();
    autoSubs.clear();

    try {
      const agents = projectManager.listAgents();
      for (const agent of agents) {
        // Auto-subscription: every agent listens to agent/{id}
        autoSubs.set(agent.id, `agent/${agent.id}`);

        // Custom subscriptions from config
        try {
          const detail = projectManager.getAgent(agent.id);
          const subs = detail.subscriptions || detail.commsSubscriptions || [];
          for (const sub of subs) {
            const pattern = _normalize(sub.pattern);
            if (!pattern) continue;

            if (!subscriptionIndex.has(pattern)) {
              subscriptionIndex.set(pattern, new Set());
            }
            subscriptionIndex.get(pattern).add(agent.id);

            if (!agentIndex.has(agent.id)) {
              agentIndex.set(agent.id, new Set());
            }
            agentIndex.get(agent.id).add(pattern);
          }
        } catch { /* skip bad config */ }
      }
    } catch (err) {
      log.warn(`[messageBroker] Failed to rebuild index: ${err.message}`);
    }

    const customCount = [...subscriptionIndex.values()].reduce((sum, s) => sum + s.size, 0);
    log.info(`[messageBroker] Index rebuilt: ${autoSubs.size} agents (auto), ${subscriptionIndex.size} patterns (${customCount} custom subscriptions)`);
  }

  function rebuildIndex() {
    _rebuildIndex();
  }

  // ─── Persistence Helpers ───────────────────────────────────────────────

  function _agentMessageFile(agentId) {
    const safeName = 'agent--' + agentId.replace(/\//g, '--');
    return path.join(messagesDir, `${safeName}.jsonl`);
  }

  function _appendMessage(agentId, msg) {
    const filePath = _agentMessageFile(agentId);
    const line = JSON.stringify(msg) + '\n';
    fs.appendFileSync(filePath, line);
  }

  function _appendUnmatched(entry) {
    const filePath = path.join(messagesDir, 'broker-unmatched.jsonl');
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line);
  }

  function _persistSubscriptions(agentId) {
    try {
      const agent = projectManager.getAgent(agentId);
      const existingSubs = agent.subscriptions || agent.commsSubscriptions || [];
      const currentPatterns = agentIndex.get(agentId) || new Set();

      const existingMap = new Map(existingSubs.map(s => [s.pattern, s]));
      const newSubs = [];

      for (const pattern of currentPatterns) {
        if (existingMap.has(pattern)) {
          newSubs.push(existingMap.get(pattern));
        } else {
          newSubs.push({ pattern, addedAt: Date.now() });
        }
      }

      projectManager.updateAgent(agentId, { subscriptions: newSubs });
    } catch (err) {
      log.error(`[messageBroker] Failed to persist subscriptions for ${agentId}: ${err.message}`);
    }
  }

  function _readJSONL(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  return {
    route,
    send,
    broadcast,
    receive,
    listen,
    subscribe,
    unsubscribe,
    getSubscriptions,
    history,
    getUnmatched,
    clearUnmatched,
    rebuildIndex,
    pathMatches,
  };
}

module.exports = { createMessageBroker };
