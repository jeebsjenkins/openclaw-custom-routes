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
 * ── Agents ────────────────────────────────────────────────────────────
 * Client → Server:
 *   { type: "agent.list" }
 *   { type: "agent.get", id }
 *   { type: "agent.create", id, config? }
 *   { type: "agent.update", id, config }
 *   { type: "agent.delete", id }
 *   { type: "agent.claudemd.get", id }
 *   { type: "agent.claudemd.set", id, content }
 *
 * ── Agent Tools ───────────────────────────────────────────────────────
 *   { type: "agent.tools.list", agentId }
 *   { type: "agent.tools.refresh", agentId? }
 *   { type: "agent.tool.execute", agentId, toolName, input }
 *
 * ── Unified Messaging (msg.*) ────────────────────────────────────────
 *   { type: "msg.send", from, to, command, payload }
 *   { type: "msg.route", from, path, source, externalId?, command?, payload }
 *   { type: "msg.broadcast", from, command, payload }
 *   { type: "msg.receive", agentId }
 *   { type: "msg.listen", agentId }
 *   { type: "msg.history", agentId, options? }
 *   { type: "msg.sub.add", agentId, pattern }
 *   { type: "msg.sub.remove", agentId, pattern }
 *   { type: "msg.sub.list", agentId }
 *   { type: "msg.unmatched", options? }
 *   { type: "msg.unmatched.clear" }
 *
 * ── Session Messaging (msg.session.*) ──────────────────────────────────
 *   { type: "msg.session.sub.add", agentId, sessionId, pattern }
 *   { type: "msg.session.sub.remove", agentId, sessionId, pattern }
 *   { type: "msg.session.sub.list", agentId, sessionId }
 *   { type: "msg.session.listen", agentId, sessionId }
 *   { type: "msg.session.receive", agentId, sessionId }
 *   { type: "msg.session.history", agentId, sessionId, options? }
 *
 * ── Sessions ─────────────────────────────────────────────────────────
 * Client → Server:
 *   { type: "session.list", agent }
 *   { type: "session.start", id?, agent, prompt, options? }
 *   { type: "session.continue", agent, sessionId, prompt, options? }
 *   { type: "session.abort", sessionId }
 *
 * ── Conversation History ─────────────────────────────────────────────
 *   { type: "conversation.history", agent, sessionId }
 *
 * ── Log Search ───────────────────────────────────────────────────────
 *   { type: "logs.search", options }
 *   { type: "logs.conversations", agentPrefix? }
 *
 * ── Keepalive ────────────────────────────────────────────────────────
 *   { type: "ping" }  →  { type: "pong" }
 */

const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

/** Expand leading ~ to the user's home directory. */
function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

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
 * @param {object}   [opts.projectManager] - ProjectManager instance
 * @param {object}   [opts.toolLoader]    - ToolLoader instance
 * @param {object}   [opts.messageBroker] - MessageBroker instance (unified messaging)
 * @param {object}   [opts.logScanner]    - LogScanner instance
 * @param {object}   [opts.agentCLIPool]  - AgentCLIPool instance
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
    toolLoader,
    messageBroker,
    logScanner,
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

  // ─── Agent handlers ─────────────────────────────────────────────────────

  if (projectManager) {
    registerHandler('agent.list', (ws, msg) => {
      try {
        const agents = projectManager.listAgents();
        reply(ws, msg, { type: 'agent.list.result', agents });
      } catch (err) {
        reply(ws, msg, { type: 'agent.list.error', error: err.message });
      }
    });

    registerHandler('agent.get', (ws, msg) => {
      try {
        const agent = projectManager.getAgent(msg.id);
        reply(ws, msg, { type: 'agent.get.result', agent });
      } catch (err) {
        reply(ws, msg, { type: 'agent.get.error', error: err.message });
      }
    });

    registerHandler('agent.create', (ws, msg) => {
      try {
        const result = projectManager.createAgent(msg.id, msg.config || {});
        reply(ws, msg, { type: 'agent.create.ok', id: msg.id, agent: result });
      } catch (err) {
        reply(ws, msg, { type: 'agent.create.error', error: err.message });
      }
    });

    registerHandler('agent.update', (ws, msg) => {
      try {
        const result = projectManager.updateAgent(msg.id, msg.config || {});
        reply(ws, msg, { type: 'agent.update.ok', id: msg.id, agent: result });
      } catch (err) {
        reply(ws, msg, { type: 'agent.update.error', error: err.message });
      }
    });

    registerHandler('agent.delete', (ws, msg) => {
      try {
        projectManager.deleteAgent(msg.id);
        reply(ws, msg, { type: 'agent.delete.ok', id: msg.id });
      } catch (err) {
        reply(ws, msg, { type: 'agent.delete.error', error: err.message });
      }
    });

    registerHandler('agent.claudemd.get', (ws, msg) => {
      try {
        const content = projectManager.getClaudeMd(msg.id);
        reply(ws, msg, { type: 'agent.claudemd.result', id: msg.id, content });
      } catch (err) {
        reply(ws, msg, { type: 'agent.claudemd.error', error: err.message });
      }
    });

    registerHandler('agent.claudemd.set', (ws, msg) => {
      try {
        projectManager.updateClaudeMd(msg.id, msg.content);
        reply(ws, msg, { type: 'agent.claudemd.ok', id: msg.id });
      } catch (err) {
        reply(ws, msg, { type: 'agent.claudemd.error', error: err.message });
      }
    });

    // ─── Session handlers ───────────────────────────────────────────────

    registerHandler('session.list', (ws, msg) => {
      try {
        const sessions = projectManager.listSessions(msg.agent);
        reply(ws, msg, { type: 'session.list.result', sessions });
      } catch (err) {
        reply(ws, msg, { type: 'session.list.error', error: err.message });
      }
    });

    registerHandler('conversation.history', (ws, msg) => {
      try {
        const entries = projectManager.getConversationLog(msg.agent, msg.sessionId);
        reply(ws, msg, { type: 'conversation.history.result', agent: msg.agent, sessionId: msg.sessionId, entries });
      } catch (err) {
        reply(ws, msg, { type: 'conversation.history.error', error: err.message });
      }
    });
  }

  // Session start/continue/abort always registered
  registerHandler('session.start', (ws, msg) => handleSessionStart(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log));
  registerHandler('session.continue', (ws, msg) => handleSessionContinue(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log));
  registerHandler('session.abort', (ws, msg) => handleSessionAbort(ws, msg, log));

  // ─── Tool handlers ──────────────────────────────────────────────────────

  if (toolLoader) {
    registerHandler('agent.tools.list', (ws, msg) => {
      try {
        const tools = toolLoader.listAgentTools(msg.agentId);
        reply(ws, msg, { type: 'agent.tools.list.result', agentId: msg.agentId, tools });
      } catch (err) {
        reply(ws, msg, { type: 'agent.tools.list.error', error: err.message });
      }
    });

    registerHandler('agent.tools.refresh', (ws, msg) => {
      try {
        toolLoader.refresh(msg.agentId);
        reply(ws, msg, { type: 'agent.tools.refresh.ok' });
      } catch (err) {
        reply(ws, msg, { type: 'agent.tools.refresh.error', error: err.message });
      }
    });

    registerHandler('agent.tool.execute', (ws, msg) => {
      const context = { messageBroker, logScanner };
      toolLoader.executeTool(msg.agentId, msg.toolName, msg.input || {}, context)
        .then(result => {
          reply(ws, msg, { type: 'agent.tool.result', agentId: msg.agentId, toolName: msg.toolName, result });
        })
        .catch(err => {
          reply(ws, msg, { type: 'agent.tool.error', error: err.message });
        });
    });
  }

  // ─── Unified message broker handlers (msg.*) ──────────────────────────

  if (messageBroker) {
    registerHandler('msg.send', (ws, msg) => {
      try {
        const result = messageBroker.send(msg.from, msg.to, {
          command: msg.command,
          payload: msg.payload,
        });
        reply(ws, msg, { type: 'msg.send.ok', messageId: result.id, message: result });
      } catch (err) {
        reply(ws, msg, { type: 'msg.send.error', error: err.message });
      }
    });

    registerHandler('msg.route', (ws, msg) => {
      try {
        const result = messageBroker.route(msg.from, msg.path, {
          command: msg.command || 'message',
          payload: msg.payload || {},
          source: msg.source || 'external',
          externalId: msg.externalId,
        });
        reply(ws, msg, { type: 'msg.route.ok', ...result });
      } catch (err) {
        reply(ws, msg, { type: 'msg.route.error', error: err.message });
      }
    });

    registerHandler('msg.broadcast', (ws, msg) => {
      try {
        const result = messageBroker.broadcast(msg.from, {
          command: msg.command,
          payload: msg.payload,
        });
        reply(ws, msg, { type: 'msg.broadcast.ok', messageId: result.id, message: result });
      } catch (err) {
        reply(ws, msg, { type: 'msg.broadcast.error', error: err.message });
      }
    });

    registerHandler('msg.receive', (ws, msg) => {
      try {
        const messages = messageBroker.receive(msg.agentId);
        reply(ws, msg, { type: 'msg.receive.ok', agentId: msg.agentId, messages });
      } catch (err) {
        reply(ws, msg, { type: 'msg.receive.error', error: err.message });
      }
    });

    registerHandler('msg.listen', (ws, msg) => {
      try {
        const unsub = messageBroker.listen(msg.agentId, (message) => {
          sendJSON(ws, { type: 'msg.push', message });
        });

        if (!ws._mbSubscriptions) ws._mbSubscriptions = [];
        ws._mbSubscriptions.push(unsub);

        reply(ws, msg, { type: 'msg.listen.ok', agentId: msg.agentId });
      } catch (err) {
        reply(ws, msg, { type: 'msg.listen.error', error: err.message });
      }
    });

    registerHandler('msg.history', (ws, msg) => {
      try {
        const messages = messageBroker.history(msg.agentId, msg.options || {});
        reply(ws, msg, { type: 'msg.history.ok', agentId: msg.agentId, messages });
      } catch (err) {
        reply(ws, msg, { type: 'msg.history.error', error: err.message });
      }
    });

    registerHandler('msg.sub.add', (ws, msg) => {
      try {
        messageBroker.subscribe(msg.agentId, msg.pattern);
        const subscriptions = messageBroker.getSubscriptions(msg.agentId);
        reply(ws, msg, { type: 'msg.sub.add.ok', agentId: msg.agentId, pattern: msg.pattern, subscriptions });
      } catch (err) {
        reply(ws, msg, { type: 'msg.sub.add.error', error: err.message });
      }
    });

    registerHandler('msg.sub.remove', (ws, msg) => {
      try {
        messageBroker.unsubscribe(msg.agentId, msg.pattern);
        const subscriptions = messageBroker.getSubscriptions(msg.agentId);
        reply(ws, msg, { type: 'msg.sub.remove.ok', agentId: msg.agentId, pattern: msg.pattern, subscriptions });
      } catch (err) {
        reply(ws, msg, { type: 'msg.sub.remove.error', error: err.message });
      }
    });

    registerHandler('msg.sub.list', (ws, msg) => {
      try {
        const subscriptions = messageBroker.getSubscriptions(msg.agentId);
        reply(ws, msg, { type: 'msg.sub.list.ok', agentId: msg.agentId, subscriptions });
      } catch (err) {
        reply(ws, msg, { type: 'msg.sub.list.error', error: err.message });
      }
    });

    registerHandler('msg.unmatched', (ws, msg) => {
      try {
        const messages = messageBroker.getUnmatched(msg.options || {});
        reply(ws, msg, { type: 'msg.unmatched.ok', messages });
      } catch (err) {
        reply(ws, msg, { type: 'msg.unmatched.error', error: err.message });
      }
    });

    registerHandler('msg.unmatched.clear', (ws, msg) => {
      try {
        const result = messageBroker.clearUnmatched();
        reply(ws, msg, { type: 'msg.unmatched.clear.ok', cleared: result.cleared });
      } catch (err) {
        reply(ws, msg, { type: 'msg.unmatched.clear.error', error: err.message });
      }
    });

    // ─── Session subscription handlers (msg.session.*) ────────────────────

    registerHandler('msg.session.sub.add', (ws, msg) => {
      try {
        messageBroker.subscribeSession(msg.agentId, msg.sessionId, msg.pattern);
        const subscriptions = messageBroker.getSessionSubscriptions(msg.agentId, msg.sessionId);
        reply(ws, msg, { type: 'msg.session.sub.add.ok', agentId: msg.agentId, sessionId: msg.sessionId, pattern: msg.pattern, subscriptions });
      } catch (err) {
        reply(ws, msg, { type: 'msg.session.sub.add.error', error: err.message });
      }
    });

    registerHandler('msg.session.sub.remove', (ws, msg) => {
      try {
        messageBroker.unsubscribeSession(msg.agentId, msg.sessionId, msg.pattern);
        const subscriptions = messageBroker.getSessionSubscriptions(msg.agentId, msg.sessionId);
        reply(ws, msg, { type: 'msg.session.sub.remove.ok', agentId: msg.agentId, sessionId: msg.sessionId, pattern: msg.pattern, subscriptions });
      } catch (err) {
        reply(ws, msg, { type: 'msg.session.sub.remove.error', error: err.message });
      }
    });

    registerHandler('msg.session.sub.list', (ws, msg) => {
      try {
        const subscriptions = messageBroker.getSessionSubscriptions(msg.agentId, msg.sessionId);
        reply(ws, msg, { type: 'msg.session.sub.list.ok', agentId: msg.agentId, sessionId: msg.sessionId, subscriptions });
      } catch (err) {
        reply(ws, msg, { type: 'msg.session.sub.list.error', error: err.message });
      }
    });

    registerHandler('msg.session.listen', (ws, msg) => {
      try {
        const unsub = messageBroker.listenSession(msg.agentId, msg.sessionId, (message) => {
          sendJSON(ws, { type: 'msg.session.push', agentId: msg.agentId, sessionId: msg.sessionId, message });
        });

        if (!ws._mbSubscriptions) ws._mbSubscriptions = [];
        ws._mbSubscriptions.push(unsub);

        reply(ws, msg, { type: 'msg.session.listen.ok', agentId: msg.agentId, sessionId: msg.sessionId });
      } catch (err) {
        reply(ws, msg, { type: 'msg.session.listen.error', error: err.message });
      }
    });

    registerHandler('msg.session.receive', (ws, msg) => {
      try {
        const messages = messageBroker.receiveSession(msg.agentId, msg.sessionId);
        reply(ws, msg, { type: 'msg.session.receive.ok', agentId: msg.agentId, sessionId: msg.sessionId, messages });
      } catch (err) {
        reply(ws, msg, { type: 'msg.session.receive.error', error: err.message });
      }
    });

    registerHandler('msg.session.history', (ws, msg) => {
      try {
        const messages = messageBroker.sessionHistory(msg.agentId, msg.sessionId, msg.options || {});
        reply(ws, msg, { type: 'msg.session.history.ok', agentId: msg.agentId, sessionId: msg.sessionId, messages });
      } catch (err) {
        reply(ws, msg, { type: 'msg.session.history.error', error: err.message });
      }
    });
  }

  // ─── Log search handlers ────────────────────────────────────────────────

  if (logScanner) {
    registerHandler('logs.search', (ws, msg) => {
      try {
        const results = logScanner.search(msg.options || {});
        reply(ws, msg, { type: 'logs.search.result', results });
      } catch (err) {
        reply(ws, msg, { type: 'logs.search.error', error: err.message });
      }
    });

    registerHandler('logs.conversations', (ws, msg) => {
      try {
        const conversations = logScanner.listConversations(msg.agentPrefix);
        reply(ws, msg, { type: 'logs.conversations.result', conversations });
      } catch (err) {
        reply(ws, msg, { type: 'logs.conversations.error', error: err.message });
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
    ws._mbSubscriptions = [];

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

      // Abort all active sessions
      for (const [sid, session] of ws._csSessions) {
        log.info(`[claudeSocket] Aborting session ${sid} (client disconnected)`);
        if (session.abort) session.abort();
      }
      ws._csSessions.clear();

      // Clean up message broker subscriptions
      for (const unsub of ws._mbSubscriptions) {
        try { unsub(); } catch { /* ignore */ }
      }
      ws._mbSubscriptions = [];

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
 * Resolve CLI options for an agent — uses the agentCLIPool if available,
 * otherwise falls back to reading agent config directly.
 *
 * When a sessionId is provided, also merges:
 *   - Session directory as an additionalDir
 *   - Session-level workDirs as additionalDirs
 *   - Three-tier memory context as systemPrompt
 */
function _resolveAgentOptions(agentId, options, projectManager, agentCLIPool, sessionId) {
  if (!agentId || !projectManager) return { ...options };

  let cliOptions;

  if (agentCLIPool) {
    const agent = agentCLIPool.getAgentCLI(agentId);
    cliOptions = { ...agent.options, ...options };
  } else {
    // Fallback: resolve directly
    const agent = projectManager.getAgent(agentId);
    cliOptions = { ...options, cwd: expandHome(agent.path) };
    if (agent.workDirs && agent.workDirs.length > 0) {
      cliOptions.additionalDirs = [...(cliOptions.additionalDirs || []), ...agent.workDirs.map(expandHome)];
    }
    if (agent.defaultModel && !cliOptions.model) {
      cliOptions.model = agent.defaultModel;
    }
  }

  // Merge session-level directories + workDirs
  if (sessionId && projectManager) {
    try {
      const sessionDir = projectManager.getSessionDir(agentId, sessionId);
      if (!cliOptions.additionalDirs) cliOptions.additionalDirs = [];
      cliOptions.additionalDirs.push(sessionDir);

      const session = projectManager.getSession(agentId, sessionId);
      if (session && session.workDirs && session.workDirs.length > 0) {
        cliOptions.additionalDirs.push(...session.workDirs.map(expandHome));
      }
    } catch { /* non-fatal — session may not exist yet */ }

    // Inject three-tier memory context
    try {
      const memoryParts = [];
      const sysMem = projectManager.getSystemMemory();
      if (sysMem && sysMem.trim()) memoryParts.push(`=== SYSTEM CONTEXT ===\n${sysMem}`);
      const agentMem = projectManager.getAgentMemory(agentId);
      if (agentMem && agentMem.trim()) memoryParts.push(`=== AGENT MEMORY ===\n${agentMem}`);
      const sessMem = projectManager.getSessionMemory(agentId, sessionId);
      if (sessMem && sessMem.trim()) memoryParts.push(`=== SESSION MEMORY ===\n${sessMem}`);

      if (memoryParts.length > 0) {
        cliOptions.systemPrompt = memoryParts.join('\n\n');
      }
    } catch { /* non-fatal */ }
  }

  return cliOptions;
}

function handleSessionStart(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log) {
  const sessionId = msg.id || crypto.randomUUID();
  const { prompt, agent, options = {} } = msg;

  if (!prompt) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'prompt is required' });
    return;
  }

  let cliOptions;
  try {
    cliOptions = _resolveAgentOptions(agent, options, projectManager, agentCLIPool, sessionId);
  } catch (err) {
    reply(ws, msg, { type: 'session.error', sessionId, error: `Agent error: ${err.message}` });
    return;
  }

  // Assign a CLI session ID so we can resume later
  cliOptions.sessionId = sessionId;

  _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, agent, log);
}

function handleSessionContinue(ws, msg, claudeStreamFn, projectManager, agentCLIPool, log) {
  const { sessionId, prompt, agent, options = {} } = msg;

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
    cliOptions = _resolveAgentOptions(agent, options, projectManager, agentCLIPool, sessionId);
  } catch (err) {
    reply(ws, msg, { type: 'session.error', sessionId, error: `Agent error: ${err.message}` });
    return;
  }

  // Use --resume to continue the conversation
  cliOptions.resumeSessionId = sessionId;

  _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, agent, log);
}

function _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, agentId, log) {
  if (ws._csSessions.has(sessionId)) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'Session ID already active' });
    return;
  }

  let aborted = false;
  ws._csSessions.set(sessionId, { abort: () => { aborted = true; } });

  // Acknowledge immediately so the client can correlate the reqId
  reply(ws, msg, { type: 'session.started', sessionId });

  log.info(`[claudeSocket] Starting session ${sessionId}: "${prompt.slice(0, 80)}..."`);

  // Log user prompt to conversation log
  if (agentId && projectManager) {
    try {
      projectManager.appendConversationLog(agentId, sessionId, {
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
      if (agentId && projectManager) {
        try {
          projectManager.saveSession(agentId, sessionId, {
            title: prompt.slice(0, 100),
            createdAt: Date.now() - durationMs,
            durationMs,
          });
        } catch { /* non-fatal */ }
        try {
          projectManager.appendConversationLog(agentId, sessionId, {
            role: 'assistant',
            type: 'result',
            text: markdown,
            durationMs,
          });
        } catch { /* non-fatal */ }
      }
      if (ws.readyState === ws.OPEN && !aborted) {
        sendJSON(ws, { type: 'session.done', sessionId, durationMs });
      }
    })
    .catch((err) => {
      // Log errors to conversation log
      if (agentId && projectManager) {
        try {
          projectManager.appendConversationLog(agentId, sessionId, {
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
