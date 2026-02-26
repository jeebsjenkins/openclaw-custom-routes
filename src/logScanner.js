/**
 * logScanner.js — Grep-like search across agent session logs.
 *
 * Loosely coupled: depends only on Node.js fs/path.
 * Can be extracted to a standalone project by copying this file.
 *
 * Searches JSONL session logs (in sessions/) across agent subtrees using regex
 * or text patterns, with filtering by role, type, time range, and agent prefix.
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a LogScanner instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory
 * @param {function} listAgentsFn - Function that returns array of { id, ... } for all agents
 * @param {object} [log] - Logger
 * @returns {object} LogScanner API
 */
function createLogScanner(projectRoot, listAgentsFn, log = console) {
  if (!projectRoot) {
    throw new Error('logScanner: projectRoot is required');
  }
  if (typeof listAgentsFn !== 'function') {
    throw new Error('logScanner: listAgentsFn is required');
  }

  /**
   * Search conversation logs across agents.
   *
   * @param {object} options
   * @param {string}  options.query       - Text or regex pattern to search
   * @param {string}  [options.agentPrefix] - Only search agents matching this prefix (e.g. "researcher")
   * @param {string}  [options.agentId]   - Search a specific agent only
   * @param {string}  [options.role]      - Filter by entry role: "user", "assistant", "system"
   * @param {string}  [options.type]      - Filter by entry type: "prompt", "result", "error"
   * @param {number}  [options.fromTime]  - Min timestamp (Unix ms)
   * @param {number}  [options.toTime]    - Max timestamp (Unix ms)
   * @param {number}  [options.limit=100] - Max results
   * @returns {object[]} Array of { agentId, sessionId, entry, lineNumber }
   */
  function search(options = {}) {
    const {
      query,
      agentPrefix,
      agentId,
      role,
      type,
      fromTime,
      toTime,
      limit = 100,
    } = options;

    if (!query) {
      throw new Error('logScanner.search: query is required');
    }

    let pattern;
    try {
      pattern = new RegExp(query, 'gi');
    } catch {
      // If invalid regex, escape it and treat as literal
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(escaped, 'gi');
    }

    // Get agents to search
    let agents = listAgentsFn();

    if (agentId) {
      agents = agents.filter(a => a.id === agentId);
    } else if (agentPrefix) {
      agents = agents.filter(a =>
        a.id === agentPrefix || a.id.startsWith(agentPrefix + '/')
      );
    }

    const results = [];

    for (const agent of agents) {
      if (results.length >= limit) break;

      const convDir = path.join(projectRoot, agent.id, 'sessions');
      if (!fs.existsSync(convDir)) continue;

      let files;
      try {
        files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        if (results.length >= limit) break;

        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(convDir, file);
        const entries = _readJSONL(filePath);

        for (let i = 0; i < entries.length; i++) {
          if (results.length >= limit) break;

          const entry = entries[i];

          // Apply filters
          if (role && entry.role !== role) continue;
          if (type && entry.type !== type) continue;
          if (fromTime && entry.timestamp < fromTime) continue;
          if (toTime && entry.timestamp > toTime) continue;

          // Match against text
          const text = entry.text || '';
          pattern.lastIndex = 0; // Reset regex state
          if (pattern.test(text)) {
            results.push({
              agentId: agent.id,
              sessionId,
              lineNumber: i + 1,
              entry,
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * List all conversations across agents, optionally filtered by prefix.
   *
   * @param {string} [agentPrefix] - Only list for agents matching this prefix
   * @returns {object[]} Array of { agentId, sessionId, title, lastUsedAt, ... }
   */
  function listConversations(agentPrefix) {
    let agents = listAgentsFn();

    if (agentPrefix) {
      agents = agents.filter(a =>
        a.id === agentPrefix || a.id.startsWith(agentPrefix + '/')
      );
    }

    const conversations = [];

    for (const agent of agents) {
      const sessionsDir = path.join(projectRoot, agent.id, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;

      let files;
      try {
        files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(sessionsDir, file), 'utf8')
          );
          conversations.push({
            agentId: agent.id,
            sessionId: file.replace('.json', ''),
            ...data,
          });
        } catch { /* skip corrupt */ }
      }
    }

    // Sort by lastUsedAt descending
    conversations.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    return conversations;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  function _readJSONL(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  return {
    search,
    listConversations,
  };
}

module.exports = { createLogScanner };
