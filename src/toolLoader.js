/**
 * toolLoader.js — Dynamic tool discovery, loading, and execution.
 *
 * Loosely coupled: depends only on Node.js fs/path. No express, ws, or other project deps.
 * Can be extracted to a standalone project by copying this file.
 *
 * Tools are loaded from two locations (agent-local overrides global):
 *   1. PROJECT_ROOT/tools/          — global tools available to all agents
 *   2. PROJECT_ROOT/<agent>/tools/  — agent-specific tools
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
 * { agentId, sessionId?, projectRoot, log, messageBroker?, logScanner? }
 */

const fs = require('fs');
const path = require('path');

/**
 * Create a ToolLoader instance.
 *
 * @param {string} projectRoot - Absolute path to the root directory
 * @param {object} [log] - Logger with info/warn/error methods
 * @returns {object} ToolLoader API
 */
function createToolLoader(projectRoot, log = console) {
  if (!projectRoot) {
    throw new Error('toolLoader: projectRoot is required');
  }

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
   * Discover and load all tools available to an agent.
   * Priority: agent-local tools override global tools of the same name.
   *
   * @param {string} agentId - Agent path ID
   * @returns {Map<string, object>} Map of toolName → toolExport
   */
  function loadAgentTools(agentId) {
    const tools = new Map();

    // 1. Load global tools
    const globalDir = path.join(projectRoot, 'tools');
    for (const [name, tool] of _scanToolDir(globalDir)) {
      tools.set(name, tool);
    }

    // 2. Load agent-local tools (override global)
    if (agentId) {
      const agentToolsDir = path.join(projectRoot, agentId, 'tools');
      for (const [name, tool] of _scanToolDir(agentToolsDir)) {
        tools.set(name, tool);
      }
    }

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

    const fullContext = {
      agentId,
      projectRoot,
      log,
      ...context,
    };

    return tool.execute(input, fullContext);
  }

  /**
   * Clear tool cache to force re-scan on next access.
   *
   * @param {string} [agentId] - Clear cache for specific agent, or all if omitted
   */
  function refresh(agentId) {
    if (agentId) {
      cache.delete(agentId);
    } else {
      cache.clear();
    }
  }

  return {
    loadAgentTools,
    listAgentTools,
    executeTool,
    refresh,
  };
}

module.exports = { createToolLoader };
