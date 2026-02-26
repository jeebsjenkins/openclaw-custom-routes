/**
 * projectManager.js — Manages project and session state on disk.
 *
 * Loosely coupled: depends only on Node.js fs/path. No express, ws, or other project deps.
 * Can be extracted to a standalone project by copying this file.
 *
 * Project structure on disk:
 *
 *   PROJECT_ROOT/
 *     my-agent/                    ← agent folder (cwd for Claude CLI)
 *       .claude/                   ← Claude's own config
 *       CLAUDE.md                  ← system prompt / project context
 *       jvAgent.json               ← our config (name, workDirs, description, defaultModel)
 *       sessions/
 *         <session-id>.json        ← session metadata
 *       conversations/
 *         <session-id>.jsonl       ← conversation log (one JSON object per line)
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

  // Ensure a "main" project exists in the root
  const mainDir = path.join(projectRoot, 'main');
  if (!fs.existsSync(path.join(mainDir, 'jvAgent.json'))) {
    _ensureAgent(mainDir, 'main', { description: 'Main agent' });
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  function listProjects() {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const projects = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const configPath = path.join(projectRoot, entry.name, 'jvAgent.json');
      let config = {};
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch { /* no config yet */ }

      projects.push({
        name: entry.name,
        description: config.description || '',
        workDirs: config.workDirs || [],
        defaultModel: config.defaultModel || null,
        hasClaudeMd: fs.existsSync(path.join(projectRoot, entry.name, 'CLAUDE.md')),
      });
    }

    return projects;
  }

  function getProject(name) {
    const projectDir = _projectDir(name);
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Project not found: ${name}`);
    }

    const configPath = path.join(projectDir, 'jvAgent.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* no config yet */ }

    const sessions = listSessions(name);

    return {
      name,
      path: projectDir,
      description: config.description || '',
      workDirs: config.workDirs || [],
      defaultModel: config.defaultModel || null,
      hasClaudeMd: fs.existsSync(path.join(projectDir, 'CLAUDE.md')),
      sessions,
    };
  }

  /**
   * Ensure an agent folder has the required scaffolding (dirs + config files).
   * Safe to call on an existing directory — only creates what's missing.
   */
  function _ensureAgent(projectDir, name, config = {}) {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'conversations'), { recursive: true });

    const configPath = path.join(projectDir, 'jvAgent.json');
    if (!fs.existsSync(configPath)) {
      const projectConfig = {
        name: config.name || name,
        description: config.description || '',
        workDirs: config.workDirs || [],
        defaultModel: config.defaultModel || null,
      };
      fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2));
    }

    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const claudeMd = config.claudeMd || `# ${config.name || name}\n\n${config.description || 'Agent project.'}\n\n## Instructions\n\n<!-- Add your system prompt / project context here -->\n`;
      fs.writeFileSync(claudeMdPath, claudeMd);
    }
  }

  function createProject(name, config = {}) {
    const projectDir = _projectDir(name);
    const isMaster = !name || name === '.' || name === '/';

    if (!isMaster && fs.existsSync(projectDir)) {
      throw new Error(`Project already exists: ${name}`);
    }

    _ensureAgent(projectDir, name, config);

    return JSON.parse(fs.readFileSync(path.join(projectDir, 'jvAgent.json'), 'utf8'));
  }

  function updateProject(name, config) {
    const projectDir = _projectDir(name);
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Project not found: ${name}`);
    }

    const configPath = path.join(projectDir, 'jvAgent.json');
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* start fresh */ }

    const merged = { ...existing, ...config };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  // ─── CLAUDE.md ────────────────────────────────────────────────────────────

  function getClaudeMd(name) {
    const filePath = path.join(_projectDir(name), 'CLAUDE.md');
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  function updateClaudeMd(name, content) {
    const filePath = path.join(_projectDir(name), 'CLAUDE.md');
    fs.writeFileSync(filePath, content);
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  function listSessions(projectName) {
    const sessionsDir = path.join(_projectDir(projectName), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        sessions.push(data);
      } catch { /* skip corrupt files */ }
    }

    // Sort by lastUsedAt descending
    sessions.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    return sessions;
  }

  function getSession(projectName, sessionId) {
    const filePath = path.join(_projectDir(projectName), 'sessions', `${sessionId}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  function saveSession(projectName, sessionId, metadata) {
    const sessionsDir = path.join(_projectDir(projectName), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const data = {
      id: sessionId,
      ...metadata,
      lastUsedAt: Date.now(),
    };
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(data, null, 2));
    return data;
  }

  // ─── Conversation Logs ──────────────────────────────────────────────────

  /**
   * Append a conversation entry to the session's log file.
   * Each entry is a single JSON line (JSONL format).
   *
   * @param {string} projectName
   * @param {string} sessionId
   * @param {object} entry - { role, type, text, ... } — any serializable object
   */
  function appendConversationLog(projectName, sessionId, entry) {
    const convDir = path.join(_projectDir(projectName), 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const logPath = path.join(convDir, `${sessionId}.jsonl`);
    const line = JSON.stringify({ ...entry, timestamp: Date.now() }) + '\n';
    fs.appendFileSync(logPath, line);
  }

  /**
   * Read the full conversation log for a session.
   *
   * @param {string} projectName
   * @param {string} sessionId
   * @returns {object[]} Array of parsed log entries
   */
  function getConversationLog(projectName, sessionId) {
    const logPath = path.join(_projectDir(projectName), 'conversations', `${sessionId}.jsonl`);
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  function deleteProject(name) {
    const projectDir = _projectDir(name);
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Project not found: ${name}`);
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function _projectDir(name) {
    // Master agent: empty name, ".", or "/" maps to projectRoot itself
    if (!name || name === '.' || name === '/') {
      return projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
    }

    // Prevent directory traversal
    const safeName = path.basename(name);
    const dir = path.join(projectRoot, safeName);

    // Ensure the resolved path is under projectRoot
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(projectRoot) + '/')) {
      throw new Error(`Invalid project name: ${name}`);
    }

    return resolved.endsWith('/') ? resolved : resolved + '/';
  }

  return {
    projectRoot,
    listProjects,
    getProject,
    createProject,
    updateProject,
    getClaudeMd,
    updateClaudeMd,
    listSessions,
    getSession,
    saveSession,
    appendConversationLog,
    getConversationLog,
    deleteProject,
  };
}

module.exports = { createProjectManager };
