/**
 * commsRouter.js — External communications router with subscription/broker hybrid.
 *
 * Routes inbound external messages (Slack, email, webhooks, etc.) to agents
 * based on path-based subscriptions with wildcard matching.
 *
 * Universal path addressing:
 *   Slack:   slack/{workspace}/#{channel}  or  slack/{workspace}/@{user}
 *   Email:   email/{to}@domain/{from}@domain
 *   Webhook: webhook/{service}/{topic}
 *   Custom:  any/path/segments
 *
 * Wildcard matching:
 *   *   — matches exactly one path segment
 *   **  — matches zero or more segments
 *
 * Subscriptions are persisted in each agent's jvAgent.json under:
 *   "commsSubscriptions": [{ "pattern": "slack/workspace/*", "addedAt": 1234567890 }]
 *
 * Unmatched messages are logged to PROJECT_ROOT/.messages/comms-unmatched.jsonl
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Create a CommsRouter instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory
 * @param {object} messageBus - MessageBus instance (send, subscribe, etc.)
 * @param {object} projectManager - ProjectManager instance (listAgents, getAgent, updateAgent)
 * @param {object} [log] - Logger with info/warn/error methods
 * @returns {object} CommsRouter API
 */
function createCommsRouter(projectRoot, messageBus, projectManager, log = console) {
  if (!projectRoot) throw new Error('commsRouter: projectRoot is required');
  if (!messageBus) throw new Error('commsRouter: messageBus is required');
  if (!projectManager) throw new Error('commsRouter: projectManager is required');

  const messagesDir = path.join(projectRoot, '.messages');
  fs.mkdirSync(messagesDir, { recursive: true });

  // Forward index: pattern → Set<agentId>
  const subscriptionIndex = new Map();
  // Reverse index: agentId → Set<pattern>
  const agentIndex = new Map();

  // Build indexes on startup
  _rebuildIndex();

  // ─── Path Matching ──────────────────────────────────────────────────────

  /**
   * Test whether a pattern matches a path.
   *
   * @param {string} pattern - Subscription pattern (may contain * and **)
   * @param {string} inPath - Inbound message path
   * @returns {boolean}
   */
  function pathMatches(pattern, inPath) {
    const patternSegs = _normalize(pattern).split('/');
    const pathSegs = _normalize(inPath).split('/');
    return _matchSegments(patternSegs, 0, pathSegs, 0);
  }

  /**
   * Recursive segment matcher supporting * and ** wildcards.
   */
  function _matchSegments(pSegs, pi, tSegs, ti) {
    // Both exhausted — match
    if (pi === pSegs.length && ti === tSegs.length) return true;

    // Pattern exhausted but path has more — no match
    if (pi === pSegs.length) return false;

    const seg = pSegs[pi];

    if (seg === '**') {
      // ** can match zero or more segments
      // Try matching the rest of pattern against every remaining position in path
      for (let skip = ti; skip <= tSegs.length; skip++) {
        if (_matchSegments(pSegs, pi + 1, tSegs, skip)) return true;
      }
      return false;
    }

    // Path exhausted but pattern has more (non-**) — no match
    if (ti === tSegs.length) return false;

    if (seg === '*') {
      // * matches exactly one segment
      return _matchSegments(pSegs, pi + 1, tSegs, ti + 1);
    }

    // Literal match
    if (seg === tSegs[ti]) {
      return _matchSegments(pSegs, pi + 1, tSegs, ti + 1);
    }

    return false;
  }

  /**
   * Normalize a path: trim slashes, collapse multiples.
   */
  function _normalize(p) {
    return (p || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  }

  // ─── Subscription Management ────────────────────────────────────────────

  /**
   * Subscribe an agent to a communications path pattern.
   * Persists to jvAgent.json.
   */
  function subscribe(agentId, pattern) {
    if (!agentId) throw new Error('agentId is required');
    if (!pattern) throw new Error('pattern is required');

    const normalized = _normalize(pattern);

    // Add to forward index
    if (!subscriptionIndex.has(normalized)) {
      subscriptionIndex.set(normalized, new Set());
    }
    subscriptionIndex.get(normalized).add(agentId);

    // Add to reverse index
    if (!agentIndex.has(agentId)) {
      agentIndex.set(agentId, new Set());
    }
    agentIndex.get(agentId).add(normalized);

    // Persist to agent config
    _persistSubscriptions(agentId);

    log.info(`[commsRouter] ${agentId} subscribed to: ${normalized}`);
    return { success: true, pattern: normalized };
  }

  /**
   * Unsubscribe an agent from a path pattern.
   */
  function unsubscribe(agentId, pattern) {
    if (!agentId) throw new Error('agentId is required');
    if (!pattern) throw new Error('pattern is required');

    const normalized = _normalize(pattern);

    // Remove from forward index
    const agents = subscriptionIndex.get(normalized);
    if (agents) {
      agents.delete(agentId);
      if (agents.size === 0) subscriptionIndex.delete(normalized);
    }

    // Remove from reverse index
    const patterns = agentIndex.get(agentId);
    if (patterns) {
      patterns.delete(normalized);
      if (patterns.size === 0) agentIndex.delete(agentId);
    }

    // Persist
    _persistSubscriptions(agentId);

    log.info(`[commsRouter] ${agentId} unsubscribed from: ${normalized}`);
    return { success: true, pattern: normalized };
  }

  /**
   * Get all subscriptions for an agent.
   */
  function getSubscriptions(agentId) {
    if (!agentId) throw new Error('agentId is required');

    const patterns = agentIndex.get(agentId);
    if (!patterns) return [];

    // Read from agent config for addedAt timestamps
    try {
      const agent = projectManager.getAgent(agentId);
      const subs = (agent.commsSubscriptions || []);
      const patternSet = new Set(patterns);
      return subs.filter(s => patternSet.has(s.pattern));
    } catch {
      // Fallback: return patterns without timestamps
      return [...patterns].map(p => ({ pattern: p, addedAt: null }));
    }
  }

  // ─── Routing ────────────────────────────────────────────────────────────

  /**
   * Route an inbound external message to subscribed agents.
   *
   * @param {object} message
   * @param {string} message.path - Communication path (e.g. "slack/workspace/#channel")
   * @param {string} [message.externalId] - External system message ID
   * @param {string} message.source - Source type (slack, email, webhook, custom)
   * @param {object} message.payload - Message content
   * @returns {object} { delivered, deliveredTo, messageIds, unmatched }
   */
  function route(message) {
    const { source, externalId, payload } = message;
    const msgPath = _normalize(message.path);

    if (!msgPath) throw new Error('message.path is required');
    if (!source) throw new Error('message.source is required');

    // Find all agents with matching subscriptions
    const matchedAgents = new Set();

    for (const [pattern, agents] of subscriptionIndex) {
      if (pathMatches(pattern, msgPath)) {
        for (const agentId of agents) {
          matchedAgents.add(agentId);
        }
      }
    }

    if (matchedAgents.size === 0) {
      // Dead-letter
      _appendUnmatched({
        id: crypto.randomUUID(),
        path: msgPath,
        externalId: externalId || null,
        source,
        payload,
        reason: 'no_subscribers',
        timestamp: Date.now(),
      });

      log.warn(`[commsRouter] No subscribers for path: ${msgPath}`);
      return { delivered: false, deliveredTo: [], messageIds: [], unmatched: true };
    }

    // Deliver to each matched agent via messageBus
    const deliveredTo = [];
    const messageIds = [];

    for (const agentId of matchedAgents) {
      try {
        const msg = messageBus.send('comms-router', agentId, {
          command: 'comms.inbound',
          payload: {
            path: msgPath,
            source,
            externalId: externalId || null,
            ...payload,
          },
        });
        deliveredTo.push(agentId);
        messageIds.push(msg.id);
      } catch (err) {
        log.error(`[commsRouter] Failed to deliver to ${agentId}: ${err.message}`);
      }
    }

    log.info(`[commsRouter] Routed ${msgPath} → ${deliveredTo.join(', ')}`);
    return { delivered: true, deliveredTo, messageIds, unmatched: false };
  }

  // ─── Unmatched / Dead-letter ────────────────────────────────────────────

  /**
   * Get unmatched (dead-letter) messages.
   */
  function getUnmatched(options = {}) {
    const { limit = 100, fromTime, toTime } = options;
    const filePath = path.join(messagesDir, 'comms-unmatched.jsonl');
    const entries = _readJSONL(filePath);

    let filtered = entries;
    if (fromTime) filtered = filtered.filter(e => e.timestamp >= fromTime);
    if (toTime) filtered = filtered.filter(e => e.timestamp <= toTime);

    // Most recent first
    filtered.sort((a, b) => b.timestamp - a.timestamp);
    return filtered.slice(0, limit);
  }

  /**
   * Clear all unmatched messages.
   */
  function clearUnmatched() {
    const filePath = path.join(messagesDir, 'comms-unmatched.jsonl');
    try {
      fs.writeFileSync(filePath, '');
      return { cleared: true };
    } catch {
      return { cleared: false };
    }
  }

  // ─── Index Management ──────────────────────────────────────────────────

  /**
   * Rebuild subscription indexes from all agent configs.
   */
  function _rebuildIndex() {
    subscriptionIndex.clear();
    agentIndex.clear();

    try {
      const agents = projectManager.listAgents();
      for (const agent of agents) {
        try {
          const detail = projectManager.getAgent(agent.id);
          const subs = detail.commsSubscriptions || [];
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
        } catch {
          // Skip agents with invalid configs
        }
      }
    } catch (err) {
      log.warn(`[commsRouter] Failed to rebuild index: ${err.message}`);
    }

    const totalSubs = [...subscriptionIndex.values()].reduce((sum, s) => sum + s.size, 0);
    log.info(`[commsRouter] Index rebuilt: ${subscriptionIndex.size} patterns, ${totalSubs} subscriptions`);
  }

  /**
   * Rebuild indexes (public API).
   */
  function rebuildIndex() {
    _rebuildIndex();
  }

  // ─── Persistence Helpers ────────────────────────────────────────────────

  /**
   * Save current in-memory subscriptions for an agent to jvAgent.json.
   */
  function _persistSubscriptions(agentId) {
    try {
      const agent = projectManager.getAgent(agentId);
      const existingSubs = agent.commsSubscriptions || [];
      const currentPatterns = agentIndex.get(agentId) || new Set();

      // Merge: keep timestamps for existing patterns, add new ones
      const existingMap = new Map(existingSubs.map(s => [s.pattern, s]));
      const newSubs = [];

      for (const pattern of currentPatterns) {
        if (existingMap.has(pattern)) {
          newSubs.push(existingMap.get(pattern));
        } else {
          newSubs.push({ pattern, addedAt: Date.now() });
        }
      }

      projectManager.updateAgent(agentId, { commsSubscriptions: newSubs });
    } catch (err) {
      log.error(`[commsRouter] Failed to persist subscriptions for ${agentId}: ${err.message}`);
    }
  }

  function _appendUnmatched(entry) {
    const filePath = path.join(messagesDir, 'comms-unmatched.jsonl');
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line);
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
    subscribe,
    unsubscribe,
    getSubscriptions,
    route,
    getUnmatched,
    clearUnmatched,
    rebuildIndex,
    pathMatches, // exported for testing
  };
}

module.exports = { createCommsRouter };
