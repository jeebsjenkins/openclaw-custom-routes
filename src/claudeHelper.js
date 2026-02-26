const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CLI_TTL_MS = 10 * 60 * 1000; // 10 minutes idle before eviction

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE') continue;
    if (key === 'NODE_OPTIONS') continue;
    if (key.startsWith('CLAUDE_CODE')) continue;
    if (key.startsWith('VSCODE')) continue;
    if (key.startsWith('ELECTRON')) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Build CLI args common to both stream and query modes.
 * Maps options to Claude CLI flags.
 */
function buildCommonArgs(options = {}) {
  const args = [];
  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }
  if (options.additionalDirs) {
    for (const dir of [].concat(options.additionalDirs)) {
      args.push('--add-dir', dir);
    }
  }
  if (options.continueSession) {
    args.push('--continue');
  }
  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  }
  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.noSessionPersistence) {
    args.push('--no-session-persistence');
  }
  return args;
}

/**
 * Run a prompt through the Claude CLI and stream events as they arrive.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string}   [options.cwd]              - Working directory for Claude CLI
 * @param {string}   [options.systemPrompt]     - System prompt to pass to Claude
 * @param {number}   [options.timeoutMs]        - Timeout in ms (default 5 min)
 * @param {string[]} [options.additionalDirs]   - Extra dirs for --add-dir
 * @param {boolean}  [options.continueSession]  - Pass --continue flag
 * @param {string}   [options.resumeSessionId]  - Pass --resume <id>
 * @param {string}   [options.sessionId]        - Pass --session-id <uuid>
 * @param {string}   [options.model]            - Pass --model <model>
 * @param {function} [onEvent]            - Called with (type, data) for each stream event
 *   type is one of:
 *     'thinking'   - { text }                 extended thinking delta
 *     'text'       - { text }                 assistant text delta
 *     'tool_use'   - { id, name, input }      tool invocation (e.g. bash, edit, read)
 *     'tool_result' - { id, content, isError } tool execution result
 *     'result'     - { text }                 final assembled text
 *     'event'      - (raw evt)                any unrecognized event
 * @returns {Promise<{ markdown: string, durationMs: number }>}
 */
function claudeStream(prompt, options = {}, onEvent) {
  const { cwd = os.tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const args = ['-p', '--verbose', '--output-format', 'stream-json', ...buildCommonArgs(options)];
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv(),
    });

    let fullText = '';
    let stderr = '';
    let lineBuf = '';

    proc.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);

          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'thinking' && block.thinking) {
                if (onEvent) onEvent('thinking', { text: block.thinking });
              } else if (block.type === 'text' && block.text) {
                fullText += block.text;
                if (onEvent) onEvent('text', { text: block.text });
              } else if (block.type === 'tool_use') {
                if (onEvent) onEvent('tool_use', {
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
              } else if (block.type === 'tool_result') {
                if (onEvent) onEvent('tool_result', {
                  id: block.tool_use_id || block.id,
                  content: block.content,
                  isError: block.is_error || false,
                });
              }
            }
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              if (onEvent) onEvent('thinking', { text: evt.delta.thinking });
            } else if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              fullText += evt.delta.text;
              if (onEvent) onEvent('text', { text: evt.delta.text });
            } else if (evt.delta?.type === 'input_json_delta') {
              // Partial tool input streaming — forward for live display
              if (onEvent) onEvent('tool_input_delta', {
                blockIndex: evt.index,
                partialJson: evt.delta.partial_json,
              });
            }
          } else if (evt.type === 'content_block_start') {
            // Signals start of a new content block (tool_use, text, thinking)
            const block = evt.content_block;
            if (block?.type === 'tool_use') {
              if (onEvent) onEvent('tool_use_start', {
                id: block.id,
                name: block.name,
                blockIndex: evt.index,
              });
            }
          } else if (evt.type === 'content_block_stop') {
            if (onEvent) onEvent('tool_use_stop', { blockIndex: evt.index });
          } else if (evt.type === 'result') {
            if (evt.result && !fullText) {
              fullText = evt.result;
            }
            if (onEvent) onEvent('result', { text: fullText });
          } else {
            // Forward everything else — subprocesses, system events, etc.
            if (onEvent) onEvent('event', evt);
          }
        } catch {
          fullText += line;
          if (onEvent) onEvent('text', { text: line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (signal) {
        reject(Object.assign(new Error('Claude CLI was killed'), { signal, durationMs }));
      } else if (code !== 0) {
        reject(Object.assign(new Error(stderr || `exit code ${code}`), { code, durationMs }));
      } else {
        resolve({ markdown: fullText.trim(), durationMs });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a prompt through the Claude CLI and return the final result.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.cwd]          - Working directory for Claude CLI
 * @param {string} [options.systemPrompt] - System prompt to pass to Claude
 * @param {number} [options.timeoutMs]    - Timeout in ms (default 5 min)
 * @returns {Promise<{ markdown: string, durationMs: number }>}
 */
function claudeQuery(prompt, options = {}) {
  const { cwd = os.tmpdir(), timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const args = ['-p', '--verbose', '--output-format', 'json', ...buildCommonArgs(options)];
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv(),
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (signal) {
        return reject(Object.assign(new Error('Claude CLI was killed'), { signal, durationMs }));
      }
      if (code !== 0) {
        return reject(Object.assign(new Error(stderr || `exit code ${code}`), { code, durationMs }));
      }

      try {
        const wrapper = JSON.parse(stdout);
        const text = wrapper.result || wrapper.text || stdout;
        const markdown = typeof text === 'string' ? text : JSON.stringify(text);
        resolve({ markdown: markdown.trim(), durationMs });
      } catch (e) {
        reject(new Error(`Failed to parse Claude output: ${e.message}\nRaw: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Create a pool of pre-staged agent CLI contexts.
 *
 * Each agent CLI resolves the project config once (cwd, workDirs, model) and
 * caches a bound streaming/query interface. Entries are evicted after `ttlMs`
 * of inactivity (no stream/query calls).
 *
 * @param {object} opts
 * @param {object}   opts.projectManager  - ProjectManager instance
 * @param {number}   [opts.ttlMs]         - Idle TTL before eviction (default 10 min)
 * @param {number}   [opts.sweepMs]       - Cleanup interval (default ttlMs / 2)
 * @param {object}   [opts.log]           - Logger
 * @returns {{ getAgentCLI, evict, destroy, stats }}
 */
function createAgentCLIPool(opts = {}) {
  const {
    projectManager,
    ttlMs = DEFAULT_CLI_TTL_MS,
    sweepMs = undefined,
    log = console,
  } = opts;

  if (!projectManager) throw new Error('createAgentCLIPool: projectManager is required');

  /** @type {Map<string, { cliOptions: object, lastUsedAt: number, sessionIds: Set<string> }>} */
  const cache = new Map();

  // Periodic sweep to evict stale entries
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.lastUsedAt > ttlMs) {
        cache.delete(key);
        log.info(`[agentCLIPool] Evicted idle agent CLI: ${key}`);
      }
    }
  }, sweepMs || Math.floor(ttlMs / 2));

  // Don't keep the process alive just for this timer
  if (sweepInterval.unref) sweepInterval.unref();

  /**
   * Resolve project config into CLI options (cached).
   */
  function _resolve(agentFolder) {
    const proj = projectManager.getProject(agentFolder);
    const cliOptions = { cwd: proj.path };

    if (proj.workDirs && proj.workDirs.length > 0) {
      cliOptions.additionalDirs = [...proj.workDirs];
    }
    if (proj.defaultModel) {
      cliOptions.model = proj.defaultModel;
    }

    return cliOptions;
  }

  /**
   * Get a pre-staged agent CLI for the given agent folder.
   *
   * Returns an object with:
   *   - stream(prompt, extraOptions, onEvent) → Promise<{ markdown, durationMs }>
   *   - query(prompt, extraOptions)           → Promise<{ markdown, durationMs }>
   *   - options                                → resolved CLI options (read-only copy)
   *   - folder                                 → agent folder name
   *   - refresh()                              → force re-resolve config from disk
   *
   * @param {string} agentFolder - Project/agent name (as known to projectManager)
   * @returns {object}
   */
  function getAgentCLI(agentFolder) {
    let entry = cache.get(agentFolder);

    if (!entry) {
      const cliOptions = _resolve(agentFolder);
      entry = { cliOptions, lastUsedAt: Date.now(), sessionIds: new Set() };
      cache.set(agentFolder, entry);
      log.info(`[agentCLIPool] Staged agent CLI: ${agentFolder}`);
    } else {
      entry.lastUsedAt = Date.now();
    }

    const cached = entry;

    return {
      folder: agentFolder,

      get options() {
        return { ...cached.cliOptions };
      },

      stream(prompt, extraOptions = {}, onEvent) {
        cached.lastUsedAt = Date.now();
        const merged = { ...cached.cliOptions, ...extraOptions };
        // Track session IDs so reset() knows what to clean up
        if (merged.sessionId) cached.sessionIds.add(merged.sessionId);
        return claudeStream(prompt, merged, onEvent);
      },

      query(prompt, extraOptions = {}) {
        cached.lastUsedAt = Date.now();
        const merged = { ...cached.cliOptions, ...extraOptions };
        if (merged.sessionId) cached.sessionIds.add(merged.sessionId);
        return claudeQuery(prompt, merged);
      },

      refresh() {
        cached.cliOptions = _resolve(agentFolder);
        cached.lastUsedAt = Date.now();
        log.info(`[agentCLIPool] Refreshed agent CLI: ${agentFolder}`);
      },

      /**
       * Clear all Claude CLI session state for this agent.
       * Removes session .jsonl files from ~/.claude/projects/<path-slug>/
       * and resets tracked session IDs.
       */
      reset() {
        const cwd = cached.cliOptions.cwd;
        if (!cwd) return;

        // Claude CLI stores sessions at ~/.claude/projects/<slug>/
        // where slug = absolute path with / replaced by -
        const slug = path.resolve(cwd).replace(/\//g, '-');
        const sessionsDir = path.join(os.homedir(), '.claude', 'projects', slug);

        let cleared = 0;
        for (const sid of cached.sessionIds) {
          // Claude stores <session-id>.jsonl and optionally <session-id>/ folder
          const jsonlFile = path.join(sessionsDir, `${sid}.jsonl`);
          const sessionFolder = path.join(sessionsDir, sid);
          try { fs.unlinkSync(jsonlFile); cleared++; } catch { /* doesn't exist */ }
          try { fs.rmSync(sessionFolder, { recursive: true }); } catch { /* doesn't exist */ }
        }

        cached.sessionIds.clear();
        log.info(`[agentCLIPool] Reset agent CLI ${agentFolder}: cleared ${cleared} session(s)`);
      },
    };
  }

  /** Manually evict an agent from the cache. */
  function evict(agentFolder) {
    cache.delete(agentFolder);
  }

  /** Shut down the pool (clears the sweep timer). */
  function destroy() {
    clearInterval(sweepInterval);
    cache.clear();
  }

  /** Return cache stats. */
  function stats() {
    const entries = [];
    for (const [key, entry] of cache) {
      entries.push({ folder: key, lastUsedAt: entry.lastUsedAt, idleMs: Date.now() - entry.lastUsedAt });
    }
    return { size: cache.size, ttlMs, entries };
  }

  return { getAgentCLI, evict, destroy, stats };
}

module.exports = { claudeQuery, claudeStream, cleanEnv, createAgentCLIPool };
