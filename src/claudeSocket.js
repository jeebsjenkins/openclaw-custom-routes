/**
 * claudeSocket.js — WebSocket server for mobile Claude CLI access
 *
 * Loosely coupled: depends only on `ws` and caller-provided functions.
 * Can be extracted to a standalone project by copying this file + projectManager.js.
 *
 * Message protocol (JSON over WebSocket):
 *
 * ── General ──────────────────────────────────────────────────────────
 * All client messages may include an optional `reqId` field.
 * Responses echo it back for client-side correlation.
 *
 * ── Auth ─────────────────────────────────────────────────────────────
 * Client → Server:
 *   { type: "auth", token }
 * Server → Client:
 *   { type: "auth.ok" }
 *   { type: "auth.error", error }
 *
 * ── Projects ─────────────────────────────────────────────────────────
 * Client → Server:
 *   { type: "project.list" }
 *   { type: "project.get", name }
 *   { type: "project.create", name, config? }
 *   { type: "project.update", name, config }
 *   { type: "project.claudemd.get", name }
 *   { type: "project.claudemd.set", name, content }
 *
 * ── Sessions ─────────────────────────────────────────────────────────
 * Client → Server:
 *   { type: "session.list", project }
 *   { type: "session.start", id?, project, prompt, options? }
 *   { type: "session.continue", project, sessionId, prompt, options? }
 *   { type: "session.abort", sessionId }
 *
 * Server → Client (streaming):
 *   { type: "session.thinking", sessionId, text }
 *   { type: "session.text", sessionId, text }
 *   { type: "session.result", sessionId, text, durationMs }
 *   { type: "session.error", sessionId, error }
 *   { type: "session.event", sessionId, data }
 *
 * ── Keepalive ────────────────────────────────────────────────────────
 *   { type: "ping" }  →  { type: "pong" }
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Start the Claude WebSocket server.
 *
 * @param {object} opts
 * @param {number}   opts.port            - Port to listen on (default 3101)
 * @param {string}   [opts.host]          - Bind address (default 0.0.0.0)
 * @param {string}   opts.token           - Shared secret for auth
 * @param {function} opts.claudeStreamFn  - (prompt, options, onEvent) => Promise
 * @param {object}   [opts.projectManager] - ProjectManager instance (optional, enables project commands)
 * @param {object}   [opts.agentCLIPool]  - AgentCLIPool instance (optional, enables cached agent CLI resolution)
 * @param {object}   [opts.log]           - Logger with info/warn/error methods
 * @returns {{ wss: WebSocketServer, close: () => void }}
 */
function start(opts = {}) {
  const {
    port = 3101,
    host = '0.0.0.0',
    token,
    claudeStreamFn,
    projectManager,
    agentCLIPool,
    log = console,
  } = opts;

  if (!token) throw new Error('claudeSocket: token is required');
  if (typeof claudeStreamFn !== 'function') throw new Error('claudeSocket: claudeStreamFn is required');

  // ─── Handler registry ───────────────────────────────────────────────────

  const handlers = {};

  function registerHandler(type, fn) {
    handlers[type] = fn;
  }

  // ─── Register built-in handlers ─────────────────────────────────────────

  registerHandler('ping', (ws, msg) => {
    reply(ws, msg, { type: 'pong' });
  });

  // Session handlers
  registerHandler('session.start', (ws, msg) => handleSessionStart(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log));
  registerHandler('session.continue', (ws, msg) => handleSessionContinue(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log));
  registerHandler('session.abort', (ws, msg) => handleSessionAbort(ws, msg, log));

  // Session list
  if (projectManager) {
    registerHandler('session.list', (ws, msg) => {
      try {
        const sessions = projectManager.listSessions(msg.project);
        reply(ws, msg, { type: 'session.list.result', sessions });
      } catch (err) {
        reply(ws, msg, { type: 'session.list.error', error: err.message });
      }
    });
  }

  // Project handlers (only if projectManager is provided)
  if (projectManager) {
    registerHandler('project.list', (ws, msg) => {
      try {
        const projects = projectManager.listProjects();
        reply(ws, msg, { type: 'project.list.result', projects });
      } catch (err) {
        reply(ws, msg, { type: 'project.list.error', error: err.message });
      }
    });

    registerHandler('project.get', (ws, msg) => {
      try {
        const project = projectManager.getProject(msg.name);
        reply(ws, msg, { type: 'project.get.result', project });
      } catch (err) {
        reply(ws, msg, { type: 'project.get.error', error: err.message });
      }
    });

    registerHandler('project.create', (ws, msg) => {
      try {
        const result = projectManager.createProject(msg.name, msg.config || {});
        reply(ws, msg, { type: 'project.create.ok', name: msg.name, project: result });
      } catch (err) {
        reply(ws, msg, { type: 'project.create.error', error: err.message });
      }
    });

    registerHandler('project.delete', (ws, msg) => {
      try {
        projectManager.deleteProject(msg.name);
        reply(ws, msg, { type: 'project.delete.ok', name: msg.name });
      } catch (err) {
        reply(ws, msg, { type: 'project.delete.error', error: err.message });
      }
    });

    registerHandler('project.update', (ws, msg) => {
      try {
        const result = projectManager.updateProject(msg.name, msg.config || {});
        reply(ws, msg, { type: 'project.update.ok', name: msg.name, project: result });
      } catch (err) {
        reply(ws, msg, { type: 'project.update.error', error: err.message });
      }
    });

    registerHandler('project.claudemd.get', (ws, msg) => {
      try {
        const content = projectManager.getClaudeMd(msg.name);
        reply(ws, msg, { type: 'project.claudemd.result', name: msg.name, content });
      } catch (err) {
        reply(ws, msg, { type: 'project.claudemd.error', error: err.message });
      }
    });

    registerHandler('project.claudemd.set', (ws, msg) => {
      try {
        projectManager.updateClaudeMd(msg.name, msg.content);
        reply(ws, msg, { type: 'project.claudemd.ok', name: msg.name });
      } catch (err) {
        reply(ws, msg, { type: 'project.claudemd.error', error: err.message });
      }
    });

    registerHandler('conversation.history', (ws, msg) => {
      try {
        const entries = projectManager.getConversationLog(msg.project, msg.sessionId);
        reply(ws, msg, { type: 'conversation.history.result', project: msg.project, sessionId: msg.sessionId, entries });
      } catch (err) {
        reply(ws, msg, { type: 'conversation.history.error', error: err.message });
      }
    });
  }

  // ─── WebSocket server ───────────────────────────────────────────────────

  const wss = new WebSocketServer({ port, host });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._csAlive === false) { ws.terminate(); continue; }
      ws._csAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    const clientAddr = req.socket.remoteAddress;
    log.info(`[claudeSocket] New connection from ${clientAddr}`);

    ws._csAlive = true;
    ws._csAuthed = false;
    ws._csSessions = new Map();

    ws.on('pong', () => { ws._csAlive = true; });

    const authTimer = setTimeout(() => {
      if (!ws._csAuthed) {
        sendJSON(ws, { type: 'auth.error', error: 'Authentication timeout' });
        ws.close(4001, 'Auth timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendJSON(ws, { type: 'error', error: 'Invalid JSON' });
        return;
      }

      // Auth gate
      if (!ws._csAuthed) {
        if (msg.type === 'auth') {
          if (msg.token && timingSafeEqual(msg.token, token)) {
            ws._csAuthed = true;
            clearTimeout(authTimer);
            reply(ws, msg, { type: 'auth.ok' });
            log.info(`[claudeSocket] Client ${clientAddr} authenticated`);
          } else {
            reply(ws, msg, { type: 'auth.error', error: 'Invalid token' });
            ws.close(4003, 'Invalid token');
          }
        } else {
          reply(ws, msg, { type: 'auth.error', error: 'Must authenticate first' });
        }
        return;
      }

      // Route to handler
      const handler = handlers[msg.type];
      if (handler) {
        try {
          handler(ws, msg);
        } catch (err) {
          log.error(`[claudeSocket] Handler error for ${msg.type}: ${err.message}`);
          reply(ws, msg, { type: `${msg.type}.error`, error: err.message });
        }
      } else {
        reply(ws, msg, { type: 'error', error: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      for (const [sid, session] of ws._csSessions) {
        log.info(`[claudeSocket] Aborting session ${sid} (client disconnected)`);
        if (session.abort) session.abort();
      }
      ws._csSessions.clear();
      log.info(`[claudeSocket] Client ${clientAddr} disconnected`);
    });

    ws.on('error', (err) => {
      log.error(`[claudeSocket] WebSocket error from ${clientAddr}: ${err.message}`);
    });
  });

  wss.on('listening', () => {
    log.info(`[claudeSocket] WebSocket server listening on ${host}:${port}`);
  });

  wss.on('error', (err) => {
    log.error(`[claudeSocket] Server error: ${err.message}`);
  });

  const close = () => {
    clearInterval(heartbeat);
    wss.close();
  };

  return { wss, close, registerHandler };
}

// ─── Session handlers ─────────────────────────────────────────────────────────

/**
 * Resolve CLI options for a project — uses the agentCLIPool if available,
 * otherwise falls back to reading project config directly.
 */
function _resolveProjectOptions(project, options, projectManager, agentCLIPool) {
  if (!project || !projectManager) return { ...options };

  if (agentCLIPool) {
    const agent = agentCLIPool.getAgentCLI(project);
    return { ...agent.options, ...options };
  }

  // Fallback: resolve directly
  const proj = projectManager.getProject(project);
  const cliOptions = { ...options, cwd: proj.path };
  if (proj.workDirs && proj.workDirs.length > 0) {
    cliOptions.additionalDirs = [...(cliOptions.additionalDirs || []), ...proj.workDirs];
  }
  if (proj.defaultModel && !cliOptions.model) {
    cliOptions.model = proj.defaultModel;
  }
  return cliOptions;
}

function handleSessionStart(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log) {
  const sessionId = msg.id || crypto.randomUUID();
  const { prompt, project, options = {} } = msg;

  if (!prompt) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'prompt is required' });
    return;
  }

  let cliOptions;
  try {
    cliOptions = _resolveProjectOptions(project, options, projectManager, agentCLIPool);
  } catch (err) {
    reply(ws, msg, { type: 'session.error', sessionId, error: `Project error: ${err.message}` });
    return;
  }

  // Assign a CLI session ID so we can resume later
  cliOptions.sessionId = sessionId;

  _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, project, log);
}

function handleSessionContinue(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log) {
  const { sessionId, prompt, project, options = {} } = msg;

  if (!sessionId) {
    reply(ws, msg, { type: 'session.error', error: 'sessionId is required' });
    return;
  }
  if (!prompt) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'prompt is required' });
    return;
  }

  let cliOptions;
  try {
    cliOptions = _resolveProjectOptions(project, options, projectManager, agentCLIPool);
  } catch (err) {
    reply(ws, msg, { type: 'session.error', sessionId, error: `Project error: ${err.message}` });
    return;
  }

  // Use --resume to continue the conversation
  cliOptions.resumeSessionId = sessionId;

  _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, project, log);
}

function _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, project, log) {
  if (ws._csSessions.has(sessionId)) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'Session ID already active' });
    return;
  }

  let aborted = false;
  ws._csSessions.set(sessionId, { abort: () => { aborted = true; } });

  log.info(`[claudeSocket] Starting session ${sessionId}: "${prompt.slice(0, 80)}..."`);

  // Log user prompt to conversation log
  if (project && projectManager) {
    try {
      projectManager.appendConversationLog(project, sessionId, {
        role: 'user',
        type: 'prompt',
        text: prompt,
      });
    } catch { /* non-fatal */ }
  }

  const onEvent = (type, data) => {
    if (aborted || ws.readyState !== ws.OPEN) return;
    switch (type) {
      case 'thinking':
        sendJSON(ws, { type: 'session.thinking', sessionId, text: data.text });
        break;
      case 'text':
        sendJSON(ws, { type: 'session.text', sessionId, text: data.text });
        break;
      case 'result':
        sendJSON(ws, { type: 'session.result', sessionId, text: data.text });
        break;
      case 'tool_use':
        sendJSON(ws, { type: 'session.tool_use', sessionId, toolId: data.id, name: data.name, input: data.input });
        break;
      case 'tool_use_start':
        sendJSON(ws, { type: 'session.tool_use_start', sessionId, toolId: data.id, name: data.name, blockIndex: data.blockIndex });
        break;
      case 'tool_input_delta':
        sendJSON(ws, { type: 'session.tool_input_delta', sessionId, blockIndex: data.blockIndex, partialJson: data.partialJson });
        break;
      case 'tool_use_stop':
        sendJSON(ws, { type: 'session.tool_use_stop', sessionId, blockIndex: data.blockIndex });
        break;
      case 'tool_result':
        sendJSON(ws, { type: 'session.tool_result', sessionId, toolId: data.id, content: data.content, isError: data.isError });
        break;
      default:
        sendJSON(ws, { type: 'session.event', sessionId, data });
    }
  };

  claudeStreamFn(prompt, cliOptions, onEvent)
    .then(({ markdown, durationMs }) => {
      // Save session metadata + conversation log
      if (project && projectManager) {
        try {
          projectManager.saveSession(project, sessionId, {
            title: prompt.slice(0, 100),
            createdAt: Date.now() - durationMs,
            durationMs,
          });
        } catch { /* non-fatal */ }
        try {
          projectManager.appendConversationLog(project, sessionId, {
            role: 'assistant',
            type: 'result',
            text: markdown,
            durationMs,
          });
        } catch { /* non-fatal */ }
      }
      if (ws.readyState === ws.OPEN && !aborted) {
        sendJSON(ws, { type: 'session.result', sessionId, text: markdown, durationMs });
      }
    })
    .catch((err) => {
      // Log errors to conversation log
      if (project && projectManager) {
        try {
          projectManager.appendConversationLog(project, sessionId, {
            role: 'system',
            type: 'error',
            text: err.message,
          });
        } catch { /* non-fatal */ }
      }
      if (ws.readyState === ws.OPEN && !aborted) {
        sendJSON(ws, { type: 'session.error', sessionId, error: err.message });
      }
    })
    .finally(() => {
      ws._csSessions.delete(sessionId);
      log.info(`[claudeSocket] Session ${sessionId} ended`);
    });
}

function handleSessionAbort(ws, msg, log) {
  const { sessionId } = msg;
  if (!sessionId) {
    reply(ws, msg, { type: 'error', error: 'sessionId is required' });
    return;
  }

  const session = ws._csSessions.get(sessionId);
  if (!session) {
    reply(ws, msg, { type: 'error', error: `No active session: ${sessionId}` });
    return;
  }

  log.info(`[claudeSocket] Aborting session ${sessionId}`);
  session.abort();
  ws._csSessions.delete(sessionId);
  reply(ws, msg, { type: 'session.aborted', sessionId });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/** Send a response, echoing reqId if present. */
function reply(ws, request, response) {
  if (request && request.reqId) {
    response.reqId = request.reqId;
  }
  sendJSON(ws, response);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { start };
