/**
 * projectManager.js — Manages agent hierarchy, sessions, and conversations on disk.
 *
 * Loosely coupled: depends only on Node.js fs/path. No express, ws, or other project deps.
 * Can be extracted to a standalone project by copying this file.
 *
 * Agents use path-based IDs: "main", "researcher", "researcher/analyzer".
 * Each agent folder contains:
 *   jvAgent.json        — config (id, name, description, workDirs, defaultModel)
 *   CLAUDE.md            — system prompt / project context
 *   .claude/             — Claude CLI config
 *   sessions/            — session metadata JSON files
 *   conversations/       — conversation log JSONL files
 *   tools/               — agent-specific tools (optional)
 *
 * Every agent gets a default "main" conversation on creation.
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a ProjectManager instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory containing agent folders
 * @returns {object} ProjectManager API
 */
function createProjectManager(projectRoot) {
  if (!projectRoot) {
    throw new Error('projectManager: projectRoot is required');
  }

  // Ensure root exists
  fs.mkdirSync(projectRoot, { recursive: true });

  // Ensure a "main" agent exists in the root
  const mainDir = path.join(projectRoot, 'main');
  if (!fs.existsSync(path.join(mainDir, 'jvAgent.json'))) {
    _ensureAgent(mainDir, 'main', { description: 'Main agent' });
  }

  // ─── Agents ──────────────────────────────────────────────────────────────

  /**
   * Recursively scan for agents under a directory.
   * An agent is any folder containing jvAgent.json.
   *
   * @param {string} dir - Directory to scan
   * @param {string} prefix - Path prefix for building IDs
   * @param {object[]} results - Accumulator array
   */
  function _scanAgents(dir, prefix, results) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      // Skip known non-agent directories
      if (['sessions', 'conversations', 'tools', 'node_modules'].includes(entry.name)) continue;

      const agentPath = path.join(dir, entry.name);
      const configPath = path.join(agentPath, 'jvAgent.json');
      const id = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (fs.existsSync(configPath)) {
        let config = {};
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch { /* skip corrupt config */ }

        results.push({
          id,
          name: entry.name,
          description: config.description || '',
          workDirs: config.workDirs || [],
          defaultModel: config.defaultModel || null,
          hasClaudeMd: fs.existsSync(path.join(agentPath, 'CLAUDE.md')),
          hasTools: fs.existsSync(path.join(agentPath, 'tools')),
        });
      }

      // Recurse into subdirectories to find child agents
      _scanAgents(agentPath, id, results);
    }
  }

  /**
   * List all agents under PROJECT_ROOT with path-based IDs.
   * @returns {object[]} Flat array of agent metadata
   */
  function listAgents() {
    const agents = [];
    _scanAgents(projectRoot, '', agents);
    return agents;
  }

  /**
   * Get a single agent by path-based ID.
   * @param {string} id - Agent ID like "main" or "researcher/analyzer"
   * @returns {object} Agent detail including sessions
   */
  function getAgent(id) {
    const agentPath = _agentDir(id);
    if (!fs.existsSync(agentPath)) {
      throw new Error(`Agent not found: ${id}`);
    }

    const configPath = path.join(agentPath, 'jvAgent.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* no config yet */ }

    const sessions = listSessions(id);

    return {
      id,
      name: path.basename(id),
      path: agentPath,
      description: config.description || '',
      workDirs: config.workDirs || [],
      defaultModel: config.defaultModel || null,
      hasClaudeMd: fs.existsSync(path.join(agentPath, 'CLAUDE.md')),
      hasTools: fs.existsSync(path.join(agentPath, 'tools')),
      subscriptions: config.subscriptions || config.commsSubscriptions || [],
      sessions,
    };
  }

  /**
   * Create a new agent at the given path-based ID.
   * Supports nested creation: "researcher/analyzer" creates both if needed.
   *
   * @param {string} id - Path-based agent ID
   * @param {object} config - Agent config (description, workDirs, etc.)
   * @returns {object} The created agent's config
   */
  function createAgent(id, config = {}) {
    const agentPath = _agentDir(id);

    if (fs.existsSync(path.join(agentPath, 'jvAgent.json'))) {
      throw new Error(`Agent already exists: ${id}`);
    }

    _ensureAgent(agentPath, id, config);

    return JSON.parse(fs.readFileSync(path.join(agentPath, 'jvAgent.json'), 'utf8'));
  }

  /**
   * Update an agent's config (merge with existing).
   */
  function updateAgent(id, config) {
    const agentPath = _agentDir(id);
    if (!fs.existsSync(agentPath)) {
      throw new Error(`Agent not found: ${id}`);
    }

    const configPath = path.join(agentPath, 'jvAgent.json');
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* start fresh */ }

    const merged = { ...existing, ...config };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  /**
   * Delete an agent and its entire subtree.
   */
  function deleteAgent(id) {
    const agentPath = _agentDir(id);
    if (!fs.existsSync(agentPath)) {
      throw new Error(`Agent not found: ${id}`);
    }
    fs.rmSync(agentPath, { recursive: true, force: true });
  }

  // ─── Agent Scaffolding ───────────────────────────────────────────────────

  /**
   * Ensure an agent folder has the required scaffolding.
   * Safe to call on an existing directory — only creates what's missing.
   * Also creates the default "main" conversation.
   */
  function _ensureAgent(agentPath, id, config = {}) {
    fs.mkdirSync(agentPath, { recursive: true });
    fs.mkdirSync(path.join(agentPath, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(agentPath, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(agentPath, 'conversations'), { recursive: true });

    const configPath = path.join(agentPath, 'jvAgent.json');
    if (!fs.existsSync(configPath)) {
      const name = path.basename(id);
      const agentConfig = {
        id,
        name: config.name || name,
        description: config.description || '',
        workDirs: config.workDirs || [],
        defaultModel: config.defaultModel || null,
      };
      fs.writeFileSync(configPath, JSON.stringify(agentConfig, null, 2));
    }

    const claudeMdPath = path.join(agentPath, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const name = config.name || path.basename(id);
      const claudeMd = config.claudeMd || `# ${name}\n\n${config.description || 'Agent project.'}\n\n## Instructions\n\n<!-- Add your system prompt / project context here -->\n`;
      fs.writeFileSync(claudeMdPath, claudeMd);
    }

    // Default "main" conversation
    _ensureDefaultConversation(agentPath);
  }

  /**
   * Create the default "main" session if it doesn't exist.
   */
  function _ensureDefaultConversation(agentPath) {
    const mainSessionPath = path.join(agentPath, 'sessions', 'main.json');
    if (!fs.existsSync(mainSessionPath)) {
      const data = {
        id: 'main',
        title: 'Main conversation',
        isDefault: true,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      fs.writeFileSync(mainSessionPath, JSON.stringify(data, null, 2));
    }
  }

  // ─── CLAUDE.md ──────────────────────────────────────────────────────────

  function getClaudeMd(id) {
    const filePath = path.join(_agentDir(id), 'CLAUDE.md');
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  function updateClaudeMd(id, content) {
    const filePath = path.join(_agentDir(id), 'CLAUDE.md');
    fs.writeFileSync(filePath, content);
  }

  // ─── Sessions ───────────────────────────────────────────────────────────

  function listSessions(agentId) {
    const sessionsDir = path.join(_agentDir(agentId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        sessions.push(data);
      } catch { /* skip corrupt files */ }
    }

    // Sort: default "main" first, then by lastUsedAt descending
    sessions.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    });
    return sessions;
  }

  function getSession(agentId, sessionId) {
    const filePath = path.join(_agentDir(agentId), 'sessions', `${sessionId}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function saveSession(agentId, sessionId, metadata) {
    const sessionsDir = path.join(_agentDir(agentId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const data = {
      id: sessionId,
      ...metadata,
      lastUsedAt: Date.now(),
    };
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(data, null, 2));
    return data;
  }

  // ─── Conversation Logs ────────────────────────────────────────────────

  /**
   * Append a conversation entry to the session's log file.
   * Each entry is a single JSON line (JSONL format).
   */
  function appendConversationLog(agentId, sessionId, entry) {
    const convDir = path.join(_agentDir(agentId), 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const logPath = path.join(convDir, `${sessionId}.jsonl`);
    const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(logPath, line);
  }

  /**
   * Read the full conversation log for a session.
   */
  function getConversationLog(agentId, sessionId) {
    const logPath = path.join(_agentDir(agentId), 'conversations', `${sessionId}.jsonl`);
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Resolve an agent ID to its absolute directory path.
   * Supports path-based IDs like "researcher/analyzer".
   * Validates against directory traversal.
   *
   * @param {string} id - Agent ID (path-based)
   * @returns {string} Absolute path to agent directory
   */
  function _agentDir(id) {
    if (!id || id === '.' || id === '/') {
      throw new Error('Agent ID is required');
    }

    // Normalize: remove leading/trailing slashes, collapse double slashes
    const normalized = id.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
    if (!normalized) {
      throw new Error('Agent ID is required');
    }

    // Validate each segment: no "..", no ".", no empty segments
    const segments = normalized.split('/');
    for (const seg of segments) {
      if (!seg || seg === '.' || seg === '..') {
        throw new Error(`Invalid agent ID: ${id}`);
      }
    }

    const dir = path.join(projectRoot, normalized);
    const resolved = path.resolve(dir);

    // Ensure the resolved path is under projectRoot
    if (!resolved.startsWith(path.resolve(projectRoot) + path.sep) &&
        resolved !== path.resolve(projectRoot)) {
      throw new Error(`Invalid agent ID: ${id}`);
    }

    return resolved;
  }

  return {
    projectRoot,

    // Agent CRUD
    listAgents,
    getAgent,
    createAgent,
    updateAgent,
    deleteAgent,

    // CLAUDE.md
    getClaudeMd,
    updateClaudeMd,

    // Sessions
    listSessions,
    getSession,
    saveSession,

    // Conversation logs
    appendConversationLog,
    getConversationLog,
  };
}

module.exports = { createProjectManager };
