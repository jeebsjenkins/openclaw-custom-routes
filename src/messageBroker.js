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
 * Sessions can also subscribe to paths. Session subscriptions are persisted in
 * the session's .json file under "subscriptions". When a message matches both a
 * session and its parent agent, both receive the message — the agent's copy is
 * flagged with `handled: true` and `handledBy: [{ agentId, sessionId }]`.
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

  // Forward index: pattern → Set<agentId>  (custom agent subscriptions only)
  const subscriptionIndex = new Map();
  // Reverse index: agentId → Set<pattern>  (custom agent subscriptions only)
  const agentIndex = new Map();
  // Auto-subscriptions: agentId → pattern  (computed, not persisted)
  const autoSubs = new Map();

  // Session subscription indexes
  // Forward: pattern → Set<"agentId:sessionId">
  const sessionSubIndex = new Map();
  // Reverse: "agentId:sessionId" → Set<pattern>
  const sessionIndex = new Map();

  // Route hooks — called after every successful delivery
  const routeHooks = [];

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

    // Find all matching subscribers (agents + sessions)
    const { agents: matchedAgents, sessions: matchedSessions } = _findMatchingSubscribers(normalizedPath, from);

    if (matchedAgents.size === 0 && matchedSessions.size === 0) {
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
      return { ...msg, delivered: false, deliveredTo: [], deliveredToSessions: [], messageIds: [], unmatched: true };
    }

    // Deliver to matched sessions first
    const deliveredToSessions = [];

    for (const [key, { agentId, sessionId }] of matchedSessions) {
      const sessionMsg = { ...msg, _deliveredTo: `${agentId}:${sessionId}` };
      _appendSessionMessage(agentId, sessionId, sessionMsg);
      emitter.emit(`session:${agentId}:${sessionId}`, sessionMsg);
      deliveredToSessions.push({ agentId, sessionId });
    }

    // Build a map of which agents had sessions handle this message
    const handledByAgent = new Map(); // agentId → [{ agentId, sessionId }]
    for (const { agentId, sessionId } of deliveredToSessions) {
      if (!handledByAgent.has(agentId)) handledByAgent.set(agentId, []);
      handledByAgent.get(agentId).push({ agentId, sessionId });
    }

    // Deliver to matched agents with handled flag
    const deliveredTo = [];
    const messageIds = [];

    for (const agentId of matchedAgents) {
      const handledBy = handledByAgent.get(agentId) || [];
      const handled = handledBy.length > 0;

      const agentMsg = {
        ...msg,
        _deliveredTo: agentId,
        handled,
        handledBy: handled ? handledBy : undefined,
      };

      _appendMessage(agentId, agentMsg);
      emitter.emit(`agent:${agentId}`, agentMsg);

      deliveredTo.push(agentId);
      messageIds.push(msg.id);
    }

    const sessionDesc = deliveredToSessions.length > 0
      ? ` sessions:[${deliveredToSessions.map(s => `${s.agentId}:${s.sessionId}`).join(', ')}]`
      : '';
    log.info(`[messageBroker] ${from} → ${normalizedPath}: ${msg.command} → [${deliveredTo.join(', ')}]${sessionDesc} (${msg.id})`);

    const result = { ...msg, delivered: true, deliveredTo, deliveredToSessions, messageIds, unmatched: false };

    // Fire route hooks (async-safe — errors don't break delivery)
    for (const hook of routeHooks) {
      try { hook(result); } catch (err) {
        log.error(`[messageBroker] Route hook error: ${err.message}`);
      }
    }

    return result;
  }

  /**
   * Find all subscribers (agents + sessions) matching a path.
   * Returns { agents: Set<agentId>, sessions: Map<key, { agentId, sessionId }> }
   * Excludes the sender from broadcast-style agent matches.
   */
  function _findMatchingSubscribers(normalizedPath, from) {
    const agents = new Set();
    const sessions = new Map(); // "agentId:sessionId" → { agentId, sessionId }

    // Check agent auto-subscriptions — bidirectional:
    //   1) sub pattern matches delivery path (normal: sub "agent/researcher" matches path "agent/researcher")
    //   2) delivery path matches sub pattern (broadcast: path "agent/**" matches sub "agent/researcher")
    for (const [agentId, autoPattern] of autoSubs) {
      if (pathMatches(autoPattern, normalizedPath) || pathMatches(normalizedPath, autoPattern)) {
        agents.add(agentId);
      }
    }

    // Check agent custom subscriptions — also bidirectional
    for (const [pattern, agentSet] of subscriptionIndex) {
      if (pathMatches(pattern, normalizedPath) || pathMatches(normalizedPath, pattern)) {
        for (const agentId of agentSet) {
          agents.add(agentId);
        }
      }
    }

    // Check session subscriptions — bidirectional
    for (const [pattern, sessionKeys] of sessionSubIndex) {
      if (pathMatches(pattern, normalizedPath) || pathMatches(normalizedPath, pattern)) {
        for (const key of sessionKeys) {
          if (!sessions.has(key)) {
            const [agentId, sessionId] = _splitSessionKey(key);
            sessions.set(key, { agentId, sessionId });
            // Also ensure the parent agent is in the agent set (cascade)
            agents.add(agentId);
          }
        }
      }
    }

    // For broadcast-style paths (agent/**), exclude the sender from agents
    if (normalizedPath.startsWith('agent/') && from && agents.has(from)) {
      const isDirectToSender = normalizedPath === `agent/${from}`;
      if (!isDirectToSender) {
        agents.delete(from);
      }
    }

    return { agents, sessions };
  }

  function _sessionKey(agentId, sessionId) {
    return `${agentId}:${sessionId}`;
  }

  function _splitSessionKey(key) {
    const idx = key.indexOf(':');
    return [key.slice(0, idx), key.slice(idx + 1)];
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

  // ─── Session Subscription Management ────────────────────────────────────

  /**
   * Add a subscription for a specific session. Persists to session .json.
   */
  function subscribeSession(agentId, sessionId, pattern) {
    if (!agentId) throw new Error('agentId is required');
    if (!sessionId) throw new Error('sessionId is required');
    if (!pattern) throw new Error('pattern is required');

    const normalized = _normalize(pattern);
    const key = _sessionKey(agentId, sessionId);

    // Forward index
    if (!sessionSubIndex.has(normalized)) {
      sessionSubIndex.set(normalized, new Set());
    }
    sessionSubIndex.get(normalized).add(key);

    // Reverse index
    if (!sessionIndex.has(key)) {
      sessionIndex.set(key, new Set());
    }
    sessionIndex.get(key).add(normalized);

    // Persist to session .json
    _persistSessionSubscriptions(agentId, sessionId);

    log.info(`[messageBroker] ${agentId}:${sessionId} subscribed to: ${normalized}`);
    return { success: true, pattern: normalized };
  }

  /**
   * Remove a subscription from a specific session.
   */
  function unsubscribeSession(agentId, sessionId, pattern) {
    if (!agentId) throw new Error('agentId is required');
    if (!sessionId) throw new Error('sessionId is required');
    if (!pattern) throw new Error('pattern is required');

    const normalized = _normalize(pattern);
    const key = _sessionKey(agentId, sessionId);

    const keys = sessionSubIndex.get(normalized);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) sessionSubIndex.delete(normalized);
    }

    const patterns = sessionIndex.get(key);
    if (patterns) {
      patterns.delete(normalized);
      if (patterns.size === 0) sessionIndex.delete(key);
    }

    _persistSessionSubscriptions(agentId, sessionId);

    log.info(`[messageBroker] ${agentId}:${sessionId} unsubscribed from: ${normalized}`);
    return { success: true, pattern: normalized };
  }

  /**
   * Get subscriptions for a specific session.
   */
  function getSessionSubscriptions(agentId, sessionId) {
    if (!agentId) throw new Error('agentId is required');
    if (!sessionId) throw new Error('sessionId is required');

    const key = _sessionKey(agentId, sessionId);
    const patterns = sessionIndex.get(key);
    if (!patterns || patterns.size === 0) return [];

    try {
      const session = projectManager.getSession(agentId, sessionId);
      const subs = (session && session.subscriptions) || [];
      const patternSet = new Set(patterns);
      return subs.filter(s => patternSet.has(s.pattern));
    } catch {
      return [...patterns].map(p => ({ pattern: p, addedAt: null }));
    }
  }

  // ─── Session Receiving / Polling ───────────────────────────────────────

  /**
   * Get pending messages for a specific session and mark them as delivered.
   */
  function receiveSession(agentId, sessionId) {
    if (!agentId) throw new Error('agentId is required');
    if (!sessionId) throw new Error('sessionId is required');

    const filePath = _sessionMessageFile(agentId, sessionId);
    const entries = _readJSONL(filePath);
    const pending = entries.filter(m => m.status === 'pending');

    if (pending.length > 0) {
      const ids = new Set(pending.map(m => m.id));
      const updated = entries.map(e => ids.has(e.id) ? { ...e, status: 'delivered' } : e);
      const content = updated.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(filePath, content);
    }

    return pending.map(m => ({ ...m, status: 'delivered' }));
  }

  // ─── Session Real-time Listening ───────────────────────────────────────

  /**
   * Subscribe to real-time messages for a specific session.
   * Returns an unsubscribe function.
   */
  function listenSession(agentId, sessionId, callback) {
    if (!agentId) throw new Error('agentId is required');
    if (!sessionId) throw new Error('sessionId is required');

    const handler = (msg) => callback(msg);
    emitter.on(`session:${agentId}:${sessionId}`, handler);

    return () => {
      emitter.off(`session:${agentId}:${sessionId}`, handler);
    };
  }

  // ─── Session History ──────────────────────────────────────────────────

  /**
   * Read message history for a specific session.
   */
  function sessionHistory(agentId, sessionId, options = {}) {
    const { limit = 100, fromTime, toTime } = options;

    const filePath = _sessionMessageFile(agentId, sessionId);
    let entries = _readJSONL(filePath);

    if (fromTime) entries = entries.filter(e => e.timestamp >= fromTime);
    if (toTime) entries = entries.filter(e => e.timestamp <= toTime);

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, limit);
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
    sessionSubIndex.clear();
    sessionIndex.clear();

    try {
      const agents = projectManager.listAgents();
      for (const agent of agents) {
        // Auto-subscription: every agent listens to agent/{id}
        autoSubs.set(agent.id, `agent/${agent.id}`);

        // Custom agent subscriptions from config
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

        // Session subscriptions
        try {
          const sessions = projectManager.listSessions(agent.id);
          for (const session of sessions) {
            const sessionSubs = session.subscriptions || [];
            for (const sub of sessionSubs) {
              const pattern = _normalize(sub.pattern);
              if (!pattern) continue;

              const key = _sessionKey(agent.id, session.id);

              if (!sessionSubIndex.has(pattern)) {
                sessionSubIndex.set(pattern, new Set());
              }
              sessionSubIndex.get(pattern).add(key);

              if (!sessionIndex.has(key)) {
                sessionIndex.set(key, new Set());
              }
              sessionIndex.get(key).add(pattern);
            }
          }
        } catch { /* skip if listSessions not available */ }
      }
    } catch (err) {
      log.warn(`[messageBroker] Failed to rebuild index: ${err.message}`);
    }

    const customCount = [...subscriptionIndex.values()].reduce((sum, s) => sum + s.size, 0);
    const sessionCount = [...sessionSubIndex.values()].reduce((sum, s) => sum + s.size, 0);
    log.info(`[messageBroker] Index rebuilt: ${autoSubs.size} agents (auto), ${customCount} custom, ${sessionCount} session subscriptions`);
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

  function _sessionMessageFile(agentId, sessionId) {
    const safeName = 'session--' + agentId.replace(/\//g, '--') + '--' + sessionId.replace(/\//g, '--');
    return path.join(messagesDir, `${safeName}.jsonl`);
  }

  function _appendSessionMessage(agentId, sessionId, msg) {
    const filePath = _sessionMessageFile(agentId, sessionId);
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

  function _persistSessionSubscriptions(agentId, sessionId) {
    try {
      const session = projectManager.getSession(agentId, sessionId);
      const existingSubs = (session && session.subscriptions) || [];
      const key = _sessionKey(agentId, sessionId);
      const currentPatterns = sessionIndex.get(key) || new Set();

      const existingMap = new Map(existingSubs.map(s => [s.pattern, s]));
      const newSubs = [];

      for (const pattern of currentPatterns) {
        if (existingMap.has(pattern)) {
          newSubs.push(existingMap.get(pattern));
        } else {
          newSubs.push({ pattern, addedAt: Date.now() });
        }
      }

      projectManager.updateSession(agentId, sessionId, { subscriptions: newSubs });
    } catch (err) {
      log.error(`[messageBroker] Failed to persist session subscriptions for ${agentId}:${sessionId}: ${err.message}`);
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

  // ─── Route Hooks ──────────────────────────────────────────────────────

  /**
   * Register a callback that fires after every successful route() delivery.
   * Callback receives the full route result object.
   * Returns an unsubscribe function.
   */
  function onRoute(callback) {
    routeHooks.push(callback);
    return () => {
      const idx = routeHooks.indexOf(callback);
      if (idx !== -1) routeHooks.splice(idx, 1);
    };
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
    onRoute,

    // Session-level subscriptions
    subscribeSession,
    unsubscribeSession,
    getSessionSubscriptions,
    receiveSession,
    listenSession,
    sessionHistory,
  };
}

module.exports = { createMessageBroker };
