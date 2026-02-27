/**
 * projectManager.js — Manages agent hierarchy and sessions on disk.
 *
 * Loosely coupled: depends only on Node.js fs/path. No express, ws, or other project deps.
 * Can be extracted to a standalone project by copying this file.
 *
 * Agents use path-based IDs: "main", "researcher", "researcher/analyzer".
 * Each agent folder contains:
 *   jvAgent.json        — config (id, name, description, workDirs, defaultModel)
 *   CLAUDE.md            — system prompt / project context
 *   .claude/             — Claude CLI config
 *   sessions/            — session metadata (.json) + conversation logs (.jsonl) side-by-side
 *   sessions/{id}/       — per-session directory (workspace/, tmp/, memory/)
 *   tools/               — agent-specific tools (optional)
 *   workspace/           — agent-level working directory for outputs
 *   tmp/                 — ephemeral scratch space
 *   memory/notes.md      — persistent agent memory across sessions
 *
 * A session IS the agent in a specific conversational context. The "main" session
 * is the generic agent catch-all. Sessions can have their own broker subscriptions,
 * workDirs, and isolated directory trees.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Expand leading ~ to the user's home directory. */
function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

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

  // Expand ~ so dotenv values like ~/Projects/Jarvis work correctly
  projectRoot = expandHome(projectRoot);

  // Ensure root exists
  fs.mkdirSync(projectRoot, { recursive: true });

  // Resolve template directory (repo-level templates/agent/)
  const templateDir = path.join(__dirname, '..', 'templates', 'agent');

  // Resolve system template directory (repo-level templates/)
  const systemTemplateDir = path.join(__dirname, '..', 'templates');

  // Ensure SYSTEM.md exists at project root
  const systemMdPath = path.join(projectRoot, 'SYSTEM.md');
  if (!fs.existsSync(systemMdPath)) {
    const systemTemplatePath = path.join(systemTemplateDir, 'SYSTEM.md');
    if (fs.existsSync(systemTemplatePath)) {
      fs.copyFileSync(systemTemplatePath, systemMdPath);
    }
  }

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
      if (['sessions', 'tools', 'workspace', 'tmp', 'memory', 'node_modules'].includes(entry.name)) continue;

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
      heartbeat: config.heartbeat || null,
      autoRun: config.autoRun || null,
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
   * Clones from templates/agent/ and interpolates {{placeholders}}.
   * Safe to call on an existing directory — only creates what's missing.
   */
  function _ensureAgent(agentPath, id, config = {}) {
    const name = config.name || path.basename(id);
    const description = config.description || '';
    const now = Date.now();

    // Template variable map — add new placeholders here
    const vars = {
      id,
      name,
      description: description || 'Agent project.',
    };

    // Clone template tree (skip .gitkeep files)
    _cloneTemplate(templateDir, agentPath, vars);

    // Apply runtime overrides to jvAgent.json (workDirs, defaultModel, etc.)
    const configPath = path.join(agentPath, 'jvAgent.json');
    if (fs.existsSync(configPath)) {
      const agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.workDirs) agentConfig.workDirs = config.workDirs;
      if (config.defaultModel) agentConfig.defaultModel = config.defaultModel;
      if (config.subscriptions) agentConfig.subscriptions = config.subscriptions;
      fs.writeFileSync(configPath, JSON.stringify(agentConfig, null, 2));
    }

    // Apply custom CLAUDE.md if provided
    if (config.claudeMd) {
      fs.writeFileSync(path.join(agentPath, 'CLAUDE.md'), config.claudeMd);
    }

    // Stamp timestamps on the default session file
    const mainSessionPath = path.join(agentPath, 'sessions', 'main.json');
    if (fs.existsSync(mainSessionPath)) {
      const session = JSON.parse(fs.readFileSync(mainSessionPath, 'utf8'));
      if (!session.createdAt) {
        session.createdAt = now;
        session.lastUsedAt = now;
        fs.writeFileSync(mainSessionPath, JSON.stringify(session, null, 2));
      }
    }
  }

  /**
   * Recursively copy a template directory to a target, interpolating
   * {{placeholder}} tokens in text files. Only creates what's missing.
   *
   * @param {string} src - Source template directory
   * @param {string} dest - Destination agent directory
   * @param {object} vars - Key/value map for {{placeholder}} replacement
   */
  function _cloneTemplate(src, dest, vars) {
    fs.mkdirSync(dest, { recursive: true });

    let entries;
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      return; // No template directory — fall through gracefully
    }

    for (const entry of entries) {
      // Skip .gitkeep files — they're only for preserving dirs in git
      if (entry.name === '.gitkeep') continue;

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        _cloneTemplate(srcPath, destPath, vars);
      } else if (!fs.existsSync(destPath)) {
        // Only create files that don't already exist
        let content = fs.readFileSync(srcPath, 'utf8');
        content = _interpolate(content, vars);
        fs.writeFileSync(destPath, content);
      }
    }
  }

  /**
   * Replace {{key}} placeholders in a string.
   */
  function _interpolate(text, vars) {
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return key in vars ? vars[key] : match;
    });
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

    const filePath = path.join(sessionsDir, `${sessionId}.json`);
    const isNew = !fs.existsSync(filePath);

    const data = {
      id: sessionId,
      ...metadata,
      lastUsedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    // Scaffold session directory tree on first save
    if (isNew) {
      _ensureSessionDirs(agentId, sessionId);
    }

    return data;
  }

  /**
   * Create a new named session with optional subscriptions.
   */
  function createSession(agentId, sessionId, config = {}) {
    const sessionsDir = path.join(_agentDir(agentId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const filePath = path.join(sessionsDir, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      throw new Error(`Session already exists: ${agentId}/${sessionId}`);
    }

    const now = Date.now();
    const data = {
      id: sessionId,
      title: config.title || sessionId,
      isDefault: false,
      subscriptions: config.subscriptions || [],
      workDirs: config.workDirs || [],
      createdAt: now,
      lastUsedAt: now,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

    // Scaffold session directory tree
    _ensureSessionDirs(agentId, sessionId);

    return data;
  }

  /**
   * Update a session's metadata (merge with existing).
   */
  function updateSession(agentId, sessionId, updates) {
    const filePath = path.join(_agentDir(agentId), 'sessions', `${sessionId}.json`);
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw new Error(`Session not found: ${agentId}/${sessionId}`);
    }

    const merged = { ...existing, ...updates, lastUsedAt: Date.now() };
    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
    return merged;
  }

  // ─── Conversation Logs ────────────────────────────────────────────────
  // Conversation logs live alongside session metadata in sessions/ as .jsonl files.

  /**
   * Append a conversation entry to the session's log file.
   * Each entry is a single JSON line (JSONL format).
   */
  function appendConversationLog(agentId, sessionId, entry) {
    const sessionsDir = path.join(_agentDir(agentId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const logPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(logPath, line);
  }

  /**
   * Read the full conversation log for a session.
   */
  function getConversationLog(agentId, sessionId) {
    const logPath = path.join(_agentDir(agentId), 'sessions', `${sessionId}.jsonl`);
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  // ─── Session Directories ─────────────────────────────────────────────────
  // Each session gets its own directory tree for workspace, tmp, and memory.

  /**
   * Ensure a session has its directory scaffolding (workspace/, tmp/, memory/).
   */
  function _ensureSessionDirs(agentId, sessionId) {
    const sessionDir = _sessionDir(agentId, sessionId);
    fs.mkdirSync(path.join(sessionDir, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'memory'), { recursive: true });

    // Create session memory/notes.md if missing
    const notesPath = path.join(sessionDir, 'memory', 'notes.md');
    if (!fs.existsSync(notesPath)) {
      fs.writeFileSync(notesPath, `# Session Notes\n\n> Maintained by the agent for this session.\n\n## Context\n\n## Notes\n`);
    }
  }

  /**
   * Get the absolute path to a session's directory.
   */
  function _sessionDir(agentId, sessionId) {
    return path.join(_agentDir(agentId), 'sessions', sessionId);
  }

  /**
   * Get the session directory path (public API).
   */
  function getSessionDir(agentId, sessionId) {
    return _sessionDir(agentId, sessionId);
  }

  // ─── Memory ────────────────────────────────────────────────────────────
  // Three-tier memory: system (project-wide) → agent → session.

  /**
   * Read project-wide SYSTEM.md.
   */
  function getSystemMemory() {
    try {
      return fs.readFileSync(path.join(projectRoot, 'SYSTEM.md'), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Write project-wide SYSTEM.md.
   */
  function updateSystemMemory(content) {
    fs.writeFileSync(path.join(projectRoot, 'SYSTEM.md'), content);
  }

  /**
   * Read agent-level memory/notes.md.
   */
  function getAgentMemory(agentId) {
    try {
      return fs.readFileSync(path.join(_agentDir(agentId), 'memory', 'notes.md'), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Write agent-level memory/notes.md.
   */
  function updateAgentMemory(agentId, content) {
    const memDir = path.join(_agentDir(agentId), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'notes.md'), content);
  }

  /**
   * Read session-level memory/notes.md.
   */
  function getSessionMemory(agentId, sessionId) {
    try {
      return fs.readFileSync(path.join(_sessionDir(agentId, sessionId), 'memory', 'notes.md'), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Write session-level memory/notes.md.
   */
  function updateSessionMemory(agentId, sessionId, content) {
    const memDir = path.join(_sessionDir(agentId, sessionId), 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'notes.md'), content);
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
    createSession,
    updateSession,
    getSessionDir,

    // Conversation logs (stored in sessions/ alongside metadata)
    appendConversationLog,
    getConversationLog,

    // Memory (three-tier: system → agent → session)
    getSystemMemory,
    updateSystemMemory,
    getAgentMemory,
    updateAgentMemory,
    getSessionMemory,
    updateSessionMemory,
  };
}

module.exports = { createProjectManager };
