/**
 * messageBus.js — Inter-agent message queue with persistence and real-time delivery.
 *
 * Loosely coupled: depends only on Node.js fs/path/crypto/events.
 * Can be extracted to a standalone project by copying this file.
 *
 * Messages are:
 *   1. Persisted to JSONL files in PROJECT_ROOT/.messages/
 *   2. Delivered in real-time to subscribed listeners (via EventEmitter)
 *
 * Message format:
 * {
 *   id: string,           // UUID
 *   from: string,         // source agent ID
 *   to: string,           // target agent ID, or '*' for broadcast
 *   command: string,       // action verb (e.g. "analyze", "generate", "notify")
 *   payload: object,       // arbitrary data
 *   status: string,        // "pending" | "delivered" | "read"
 *   timestamp: number      // Unix ms
 * }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * Create a MessageBus instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory
 * @param {object} [log] - Logger with info/warn/error methods
 * @returns {object} MessageBus API
 */
function createMessageBus(projectRoot, log = console) {
  if (!projectRoot) {
    throw new Error('messageBus: projectRoot is required');
  }

  const messagesDir = path.join(projectRoot, '.messages');
  fs.mkdirSync(messagesDir, { recursive: true });

  const emitter = new EventEmitter();
  emitter.setMaxListeners(100); // Allow many agent subscriptions

  /**
   * Send a message from one agent to another.
   * Persists to disk and notifies real-time subscribers.
   *
   * @param {string} from - Source agent ID
   * @param {string} to - Target agent ID (or '*' for broadcast)
   * @param {object} message - { command, payload }
   * @returns {object} The full message with id and timestamp
   */
  function send(from, to, message) {
    const msg = {
      id: crypto.randomUUID(),
      from,
      to,
      command: message.command || 'message',
      payload: message.payload || {},
      status: 'pending',
      timestamp: Date.now(),
    };

    // Persist
    _appendMessage(msg);

    // Real-time delivery
    if (to === '*') {
      emitter.emit('broadcast', msg);
    } else {
      emitter.emit(`agent:${to}`, msg);
    }

    log.info(`[messageBus] ${from} → ${to}: ${msg.command} (${msg.id})`);
    return msg;
  }

  /**
   * Get pending messages for an agent and mark them as delivered.
   *
   * @param {string} agentId - Target agent ID
   * @returns {object[]} Array of pending messages
   */
  function receive(agentId) {
    const messages = _readAgentMessages(agentId)
      .filter(m => m.status === 'pending');

    // Mark as delivered
    for (const msg of messages) {
      msg.status = 'delivered';
    }

    // Rewrite the file with updated statuses
    if (messages.length > 0) {
      _markDelivered(agentId, messages.map(m => m.id));
    }

    return messages;
  }

  /**
   * Subscribe to real-time messages for an agent.
   * Returns an unsubscribe function.
   *
   * @param {string} agentId - Agent ID to subscribe to
   * @param {function} callback - Called with (message) on delivery
   * @returns {function} Unsubscribe function
   */
  function subscribe(agentId, callback) {
    const agentHandler = (msg) => callback(msg);
    const broadcastHandler = (msg) => {
      if (msg.from !== agentId) callback(msg); // Don't echo broadcasts to sender
    };

    emitter.on(`agent:${agentId}`, agentHandler);
    emitter.on('broadcast', broadcastHandler);

    return () => {
      emitter.off(`agent:${agentId}`, agentHandler);
      emitter.off('broadcast', broadcastHandler);
    };
  }

  /**
   * Broadcast a message to all agents.
   */
  function broadcast(from, message) {
    return send(from, '*', message);
  }

  /**
   * Read message history for an agent (both sent and received).
   *
   * @param {string} agentId - Agent ID
   * @param {object} [options] - { limit, fromTime, toTime }
   * @returns {object[]} Array of messages
   */
  function history(agentId, options = {}) {
    const { limit = 100, fromTime, toTime } = options;
    const allMessages = [];

    // Read all JSONL files in .messages/ that involve this agent
    let files;
    try {
      files = fs.readdirSync(messagesDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return [];
    }

    for (const file of files) {
      const filePath = path.join(messagesDir, file);
      const entries = _readJSONL(filePath);

      for (const entry of entries) {
        if (entry.from !== agentId && entry.to !== agentId && entry.to !== '*') continue;
        if (fromTime && entry.timestamp < fromTime) continue;
        if (toTime && entry.timestamp > toTime) continue;
        allMessages.push(entry);
      }
    }

    // Sort by timestamp descending and apply limit
    allMessages.sort((a, b) => b.timestamp - a.timestamp);
    return allMessages.slice(0, limit);
  }

  // ─── Persistence Helpers ──────────────────────────────────────────────

  /**
   * Get the JSONL file path for a message pair.
   * Uses the target agent ID as the filename.
   */
  function _messageFilePath(toAgent) {
    const safeName = toAgent.replace(/\//g, '--');
    return path.join(messagesDir, `${safeName}.jsonl`);
  }

  function _appendMessage(msg) {
    const filePath = _messageFilePath(msg.to);
    const line = JSON.stringify(msg) + '\n';
    fs.appendFileSync(filePath, line);
  }

  function _readAgentMessages(agentId) {
    const filePath = _messageFilePath(agentId);
    return _readJSONL(filePath);
  }

  function _markDelivered(agentId, messageIds) {
    const filePath = _messageFilePath(agentId);
    const entries = _readJSONL(filePath);
    const idSet = new Set(messageIds);

    const updated = entries.map(e => {
      if (idSet.has(e.id)) {
        return { ...e, status: 'delivered' };
      }
      return e;
    });

    const content = updated.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
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
    send,
    receive,
    subscribe,
    broadcast,
    history,
  };
}

module.exports = { createMessageBus };
