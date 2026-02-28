/**
 * toolLoader.js — Dynamic tool discovery, loading, and execution.
 *
 * Loosely coupled: depends only on Node.js fs/path. No express, ws, or other project deps.
 * Can be extracted to a standalone project by copying this file.
 *
 * Tools are loaded with hierarchical inheritance:
 *   1. PROJECT_ROOT/tools/                 — global tools (lowest priority)
 *   2. PROJECT_ROOT/{parent}/tools/        — parent agent tools (for nested agents)
 *   3. PROJECT_ROOT/{parent}/{child}/tools/ — agent-local tools (highest priority)
 *
 * For a nested agent like "impl/acme", tool resolution order is:
 *   tools/ → impl/tools/ → impl/acme/tools/
 * Tools with the same name at a more specific level override parent tools.
 *
 * Tool contract (each .js file must export):
 * {
 *   name: string,
 *   description: string,
 *   schema: object,                         // JSON Schema for input validation
 *   execute: async (input, context) => ({   // Run the tool
 *     output: string|object,
 *     isError: boolean
 *   })
 * }
 *
 * Context passed to execute():
 * { agentId, sessionId?, agentConfig?, agentSecrets?, projectRoot, log, messageBroker?, logScanner? }
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a ToolLoader instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory
 * @param {object} [log] - Logger with info/warn/error methods
 * @param {object} [opts] - Optional dependencies
 * @param {object} [opts.projectManager] - ProjectManager instance (for secrets + config injection)
 * @returns {object} ToolLoader API
 */
function createToolLoader(projectRoot, log = console, opts = {}) {
  if (!projectRoot) {
    throw new Error('toolLoader: projectRoot is required');
  }

  const { projectManager } = opts;
  const bundledToolsDir = path.join(__dirname, '..', 'tools');

  // serviceLoader can be set after creation (circular dependency: server creates
  // toolLoader before serviceLoader, then sets it).
  let _serviceLoader = opts.serviceLoader || null;

  /**
   * Set the serviceLoader reference (called by server.js after creation).
   */
  function setServiceLoader(sl) { _serviceLoader = sl; }

  // Cache: Map<cacheKey, Map<toolName, toolExport>>
  const cache = new Map();

  /**
   * Load a single tool file. Clears require cache for hot-reload.
   *
   * @param {string} filePath - Absolute path to the tool .js file
   * @returns {object|null} Tool export or null if invalid
   */
  function _loadTool(filePath) {
    try {
      delete require.cache[require.resolve(filePath)];
      const tool = require(filePath);

      if (!tool.name || typeof tool.name !== 'string') {
        log.warn(`[toolLoader] Tool missing 'name': ${filePath}`);
        return null;
      }
      if (typeof tool.execute !== 'function') {
        log.warn(`[toolLoader] Tool missing 'execute' function: ${filePath}`);
        return null;
      }

      return tool;
    } catch (err) {
      log.error(`[toolLoader] Failed to load tool ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Scan a directory for tool .js files and load them.
   *
   * @param {string} dir - Directory to scan
   * @returns {Map<string, object>} Map of toolName → toolExport
   */
  function _scanToolDir(dir) {
    const tools = new Map();
    if (!fs.existsSync(dir)) return tools;

    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    } catch {
      return tools;
    }

    for (const file of files) {
      const tool = _loadTool(path.join(dir, file));
      if (tool) {
        tools.set(tool.name, tool);
      }
    }

    return tools;
  }

  /**
   * Build the ordered list of tool directories for an agent.
   * Walks the path hierarchy from global → parent → agent.
   * More specific directories override less specific ones.
   *
   * For "impl/acme": [tools/, impl/tools/, impl/acme/tools/]
   */
  function _getToolDirs(agentId) {
    const dirs = [];

    // 1. Built-in tools bundled with this server repo (lowest priority)
    dirs.push(bundledToolsDir);

    // 2. Project global tools
    dirs.push(path.join(projectRoot, 'tools'));

    // 3. Walk parent hierarchy (for nested agents)
    if (agentId) {
      const parts = agentId.split('/');
      for (let i = 1; i <= parts.length; i++) {
        dirs.push(path.join(projectRoot, parts.slice(0, i).join('/'), 'tools'));
      }
    }

    // Keep order, drop duplicates and non-existent directories
    const seen = new Set();
    return dirs.filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      return fs.existsSync(dir);
    });
  }

  /**
   * Discover and load all tools available to an agent.
   * Uses hierarchical inheritance: global → parent → agent-local.
   * More specific tools override less specific ones with the same name.
   *
   * @param {string} agentId - Agent path ID
   * @returns {Map<string, object>} Map of toolName → toolExport
   */
  function loadAgentTools(agentId) {
    const tools = new Map();
    const dirs = _getToolDirs(agentId);

    log.info(`[toolLoader] Loading tools for "${agentId || '__global__'}" from: ${dirs.join(', ') || '(none)'}`);

    for (const dir of dirs) {
      for (const [name, tool] of _scanToolDir(dir)) {
        tools.set(name, tool);
      }
    }

    log.info(`[toolLoader] Loaded ${tools.size} tool(s) for "${agentId || '__global__'}": ${Array.from(tools.keys()).join(', ') || '(none)'}`);

    return tools;
  }

  /**
   * Get cached tools for an agent (loads on first access).
   */
  function _getCachedTools(agentId) {
    const key = agentId || '__global__';
    if (!cache.has(key)) {
      cache.set(key, loadAgentTools(agentId));
    }
    return cache.get(key);
  }

  /**
   * List all tools available to an agent with metadata (no execute fn).
   *
   * @param {string} agentId - Agent path ID
   * @returns {object[]} Array of { name, description, schema }
   */
  function listAgentTools(agentId) {
    const tools = _getCachedTools(agentId);
    const result = [];

    for (const [, tool] of tools) {
      result.push({
        name: tool.name,
        description: tool.description || '',
        schema: tool.schema || {},
      });
    }

    return result;
  }

  /**
   * Execute a tool for an agent.
   *
   * @param {string} agentId - Agent path ID
   * @param {string} toolName - Tool name to execute
   * @param {object} input - Tool input (validated against schema by the tool)
   * @param {object} context - Execution context (agentId, projectRoot, log, messageBroker, etc.)
   * @returns {Promise<{ output: string|object, isError: boolean }>}
   */
  async function executeTool(agentId, toolName, input, context = {}) {
    const tools = _getCachedTools(agentId);
    const tool = tools.get(toolName);

    if (!tool) {
      throw new Error(`Tool not found: ${toolName} (agent: ${agentId})`);
    }

    // Build enriched context with secrets and config
    const fullContext = {
      agentId,
      projectRoot,
      log,
      ...context,
    };

    // Inject per-agent secrets and raw config if projectManager is available
    if (projectManager) {
      try { fullContext.agentSecrets = projectManager.getAgentSecrets(agentId); } catch { /* non-fatal */ }
      try { fullContext.agentConfig = projectManager.getAgentConfigRaw(agentId); } catch { /* non-fatal */ }
    }

    // Inject serviceLoader for tools like service-status that manage services
    if (_serviceLoader) {
      fullContext.serviceLoader = _serviceLoader;
    }

    return tool.execute(input, fullContext);
  }

  /**
   * Clear tool cache to force re-scan on next access.
   *
   * @param {string} [agentId] - Clear cache for specific agent, or all if omitted
   */
  function refresh(agentId) {
    if (agentId) {
      cache.delete(agentId || '__global__');
    } else {
      cache.clear();
    }
  }

  return {
    loadAgentTools,
    listAgentTools,
    executeTool,
    refresh,
    setServiceLoader,
  };
}

module.exports = { createToolLoader };
