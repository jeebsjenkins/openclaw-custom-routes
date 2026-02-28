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
 * ── Ask-User (interactive tool ↔ dashboard) ─────────────────────────
 * Server → Client:
 *   { type: "ask-user", questionId, agentId, sessionId, question, options?, context? }
 * Client → Server:
 *   { type: "ask-user.response", questionId, answer }
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
const fs = require('fs');
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
 * @param {object}   [opts.anthropicClient] - Anthropic API client (for triage/title generation)
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
    anthropicClient,
    log = console,
  } = opts;

  if (!token) throw new Error('claudeSocket: token is required');
  if (typeof claudeStreamFn !== 'function') throw new Error('claudeSocket: claudeStreamFn is required');

  // ─── Handler registry ───────────────────────────────────────────────────

  const handlers = {};

  function registerHandler(type, fn) {
    handlers[type] = fn;
  }

  function _safeReadJSON(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function _safeWriteJSON(filePath, value) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch { /* non-fatal */ }
  }

  // ─── Pending user questions (ask-user tool) ────────────────────────────
  //
  // When an agent calls the ask-user tool, the question is stored here and
  // pushed to all connected dashboard clients. When a client responds, the
  // corresponding promise is resolved and the tool returns the answer.

  const pendingQuestions = new Map(); // questionId → { resolve, reject, timer, agentId, sessionId }
  const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for user to respond
  const ASK_USER_INDEX_FILE = path.join(os.tmpdir(), 'openclaw-ask-user-index.json');
  const askUserIndex = _safeReadJSON(ASK_USER_INDEX_FILE, {}); // questionId → metadata

  function _persistAskUserIndex() {
    _safeWriteJSON(ASK_USER_INDEX_FILE, askUserIndex);
  }

  function _lateAnswersFile(agentId, sessionId) {
    if (!projectManager || !agentId || !sessionId) return null;
    try {
      const sessionDir = projectManager.getSessionDir(agentId, sessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      return path.join(sessionDir, 'ask-user-late-answers.json');
    } catch {
      return null;
    }
  }

  function _queueLateAnswer({ questionId, agentId, sessionId, question, answer }) {
    const filePath = _lateAnswersFile(agentId, sessionId);
    if (!filePath) return false;
    const list = _safeReadJSON(filePath, []);
    list.push({
      questionId,
      question: question || null,
      answer,
      answeredAt: Date.now(),
    });
    // Keep only recent entries to avoid unbounded growth.
    while (list.length > 50) list.shift();
    _safeWriteJSON(filePath, list);
    return true;
  }

  /**
   * Create an askUser function bound to a specific session context.
   * This is injected into the tool execution context so the ask-user
   * tool can push questions to the dashboard and wait for answers.
   */
  function createAskUser(agentId, sessionId) {
    return function askUser({ question, options, context: ctx }) {
      return new Promise((resolve, reject) => {
        const questionId = crypto.randomUUID();

        const timer = setTimeout(() => {
          pendingQuestions.delete(questionId);
          if (askUserIndex[questionId]) {
            askUserIndex[questionId].status = 'timed_out';
            askUserIndex[questionId].timedOutAt = Date.now();
            _persistAskUserIndex();
          }
          reject(new Error('User response timeout (5 minutes)'));
        }, ASK_USER_TIMEOUT_MS);

        pendingQuestions.set(questionId, { resolve, reject, timer, agentId, sessionId });
        askUserIndex[questionId] = {
          questionId,
          agentId: agentId || null,
          sessionId: sessionId || null,
          question,
          options: options || null,
          context: ctx || null,
          createdAt: Date.now(),
          status: 'pending',
        };
        _persistAskUserIndex();

        // Push to all authenticated clients
        const payload = {
          type: 'ask-user',
          questionId,
          agentId,
          sessionId,
          question,
          options: options || null,
          context: ctx || null,
        };

        for (const client of wss.clients) {
          if (client._csAuthed && client.readyState === client.OPEN) {
            sendJSON(client, payload);
          }
        }

        log.info(`[claudeSocket] ask-user question pushed: ${questionId} — "${question}"`);
      });
    };
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
  registerHandler('session.start', (ws, msg) => handleSessionStart(ws, msg, claudeStreamFn, projectManager, agentCLIPool, toolLoader, anthropicClient, log));
  registerHandler('session.continue', (ws, msg) => handleSessionContinue(ws, msg, claudeStreamFn, projectManager, agentCLIPool, toolLoader, anthropicClient, log));
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
      const context = {
        messageBroker,
        logScanner,
        sessionId: msg.sessionId || null,
        askUser: createAskUser(msg.agentId, msg.sessionId || null),
      };
      toolLoader.executeTool(msg.agentId, msg.toolName, msg.input || {}, context)
        .then(result => {
          reply(ws, msg, { type: 'agent.tool.result', agentId: msg.agentId, toolName: msg.toolName, result });
        })
        .catch(err => {
          reply(ws, msg, { type: 'agent.tool.error', error: err.message });
        });
    });
  }

  // ─── Ask-user response handler ────────────────────────────────────────
  //
  // Dashboard clients send this when the user answers a question from the
  // ask-user tool. The questionId correlates to a pending promise.

  registerHandler('ask-user.response', (ws, msg) => {
    const pending = pendingQuestions.get(msg.questionId);
    if (!pending) {
      const meta = askUserIndex[msg.questionId];
      if (!meta || !meta.agentId || !meta.sessionId) {
        reply(ws, msg, { type: 'ask-user.response.error', error: 'No pending question with that ID (may have timed out)' });
        return;
      }

      const queued = _queueLateAnswer({
        questionId: msg.questionId,
        agentId: meta.agentId,
        sessionId: meta.sessionId,
        question: meta.question,
        answer: msg.answer,
      });

      if (queued) {
        meta.status = 'answered_late';
        meta.answeredAt = Date.now();
        _persistAskUserIndex();

        try {
          projectManager.appendConversationLog(meta.agentId, meta.sessionId, {
            role: 'user',
            type: 'ask-user.response.late',
            text: typeof msg.answer === 'string' ? msg.answer : JSON.stringify(msg.answer),
            questionId: msg.questionId,
            question: meta.question || '',
          });
        } catch { /* non-fatal */ }

        log.info(`[claudeSocket] ask-user late response queued: ${msg.questionId} — "${String(msg.answer).slice(0, 100)}"`);
        reply(ws, msg, {
          type: 'ask-user.response.ok',
          questionId: msg.questionId,
          queuedForSession: true,
          agentId: meta.agentId,
          sessionId: meta.sessionId,
        });
      } else {
        reply(ws, msg, { type: 'ask-user.response.error', error: 'Failed to queue late answer' });
      }
      return;
    }

    clearTimeout(pending.timer);
    pendingQuestions.delete(msg.questionId);
    pending.resolve(msg.answer);
    if (askUserIndex[msg.questionId]) {
      askUserIndex[msg.questionId].status = 'answered';
      askUserIndex[msg.questionId].answeredAt = Date.now();
      _persistAskUserIndex();
    }

    log.info(`[claudeSocket] ask-user response received: ${msg.questionId} — "${String(msg.answer).slice(0, 100)}"`);
    reply(ws, msg, { type: 'ask-user.response.ok', questionId: msg.questionId });
  });

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
 *   - Available tool documentation (if toolLoader provided)
 */
function _resolveAgentOptions(agentId, options, projectManager, agentCLIPool, sessionId, toolLoader, log = console) {
  if (!agentId || !projectManager) return { ...options };

  let cliOptions;
  let hasAskUserTool = false;

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

    // Inject CLAUDE.md chain + three-tier memory context
    try {
      const memoryParts = [];

      // CLAUDE.md inheritance chain (root parent → child agent)
      if (typeof projectManager.getClaudeMdChain === 'function') {
        const claudeMdChain = projectManager.getClaudeMdChain(agentId);
        if (claudeMdChain && claudeMdChain.trim()) memoryParts.push(`=== AGENT INSTRUCTIONS ===\n${claudeMdChain}`);
      }

      const sysMem = projectManager.getSystemMemory();
      if (sysMem && sysMem.trim()) memoryParts.push(`=== SYSTEM CONTEXT ===\n${sysMem}`);
      const agentMem = projectManager.getAgentMemory(agentId);
      if (agentMem && agentMem.trim()) memoryParts.push(`=== AGENT MEMORY ===\n${agentMem}`);
      const sessMem = projectManager.getSessionMemory(agentId, sessionId);
      if (sessMem && sessMem.trim()) memoryParts.push(`=== SESSION MEMORY ===\n${sessMem}`);

      // Inject available tool documentation so the agent knows what tools exist
      if (toolLoader) {
        try {
          const tools = toolLoader.listAgentTools(agentId);
          log.info(`[_resolveAgentOptions] Found ${tools.length} tools for agent "${agentId}": ${tools.map(t => t.name).join(', ')}`);
          const toolDocs = _buildToolDocs(agentId, toolLoader, tools);
          if (toolDocs) memoryParts.push(toolDocs);

          // If our ask-user tool exists, block the built-in AskUserQuestion
          // so the CLI agent uses our dashboard-connected version instead.
          hasAskUserTool = tools.some(t => t.name === 'ask-user');
          if (hasAskUserTool) {
            if (!cliOptions.disallowedTools) cliOptions.disallowedTools = [];
            cliOptions.disallowedTools.push('AskUserQuestion');
            log.info('[_resolveAgentOptions] Blocking built-in AskUserQuestion — ask-user tool found');
          }
        } catch (err) {
          log.error(`[_resolveAgentOptions] Tool injection error: ${err.message}`);
        }
      }

      if (memoryParts.length > 0) {
        cliOptions.systemPrompt = memoryParts.join('\n\n');
      }
    } catch (err) {
      log.error(`[_resolveAgentOptions] Memory/context injection error: ${err.message}`);
    }
  }

  // Always block built-in interactive question tool for socket sessions.
  // The intended interaction path is the dashboard ask-user flow.
  cliOptions.disallowedTools = [].concat(cliOptions.disallowedTools || []);
  if (!cliOptions.disallowedTools.includes('AskUserQuestion')) {
    cliOptions.disallowedTools.push('AskUserQuestion');
    log.info('[_resolveAgentOptions] Blocking AskUserQuestion (session default)');
  }

  // If ask-user is available and caller did not explicitly choose a permission
  // mode, default to bypassPermissions so Bash can execute tool-cli ask-user
  // without stalling on approval prompts.
  if (!cliOptions.permissionMode && hasAskUserTool) {
    cliOptions.permissionMode = 'bypassPermissions';
    log.info('[_resolveAgentOptions] Setting permissionMode=bypassPermissions (ask-user default)');
  }

  log.info(`[_resolveAgentOptions] Final disallowedTools: ${JSON.stringify(cliOptions.disallowedTools || [])}`);
  return cliOptions;
}

/**
 * Build tool documentation string for injection into the system prompt.
 * Tells the agent what tools are available and how to call them via Bash.
 */
function _buildToolDocs(agentId, toolLoader, tools) {
  if (!tools) tools = toolLoader.listAgentTools(agentId);
  if (!tools || tools.length === 0) return null;

  const toolCliPath = path.join(__dirname, 'tool-cli.js');

  const lines = [
    '=== AVAILABLE TOOLS ===',
    '',
    'You have access to the following server-side tools via the tool-cli bridge.',
    'Call them using Bash. Secrets (API keys, tokens) are injected server-side — you never need to provide them.',
    '',
    'Your agent ID and session ID are automatically available in the environment',
    '(TOOL_AGENT_ID, TOOL_SESSION_ID). You do NOT need to pass --agent or --session;',
    'the tool-cli reads them from the environment by default.',
    '',
    'IMPORTANT: When you need to ask the user a question or get input, use the ask-user tool via Bash (shown below).',
    'Do NOT use the built-in AskUserQuestion tool — it is disabled. Use ask-user instead.',
    '',
    'Usage:',
    `  node ${toolCliPath} <tool-name> --input '<json>'`,
    `  node ${toolCliPath} list`,
    '',
  ];

  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    if (tool.description) lines.push(tool.description);

    if (tool.schema && tool.schema.properties) {
      const props = Object.entries(tool.schema.properties);
      if (props.length > 0) {
        lines.push('Parameters:');
        for (const [key, val] of props) {
          const req = (tool.schema.required || []).includes(key) ? ' (required)' : '';
          const desc = val.description ? ` — ${val.description}` : '';
          const enumVals = val.enum ? ` [${val.enum.join('|')}]` : '';
          lines.push(`  ${key}: ${val.type || 'any'}${enumVals}${req}${desc}`);
        }
      }
    }

    // Example invocation
    const exampleInput = _buildExampleInput(tool);
    lines.push(`Example: node ${toolCliPath} ${tool.name} --input '${JSON.stringify(exampleInput)}'`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a minimal example input object from a tool's schema.
 */
function _buildExampleInput(tool) {
  if (!tool.schema || !tool.schema.properties) return {};
  const example = {};
  const required = tool.schema.required || [];

  for (const [key, val] of Object.entries(tool.schema.properties)) {
    // Include required props and the first optional prop with a default
    if (required.includes(key) || val.default !== undefined) {
      if (val.default !== undefined) {
        example[key] = val.default;
      } else if (val.enum && val.enum.length > 0) {
        example[key] = val.enum[0];
      } else if (val.type === 'string') {
        example[key] = `<${key}>`;
      } else if (val.type === 'object') {
        example[key] = {};
      } else {
        example[key] = `<${key}>`;
      }
    }
  }

  // If nothing was required, include the first property as a hint
  if (Object.keys(example).length === 0) {
    const firstKey = Object.keys(tool.schema.properties)[0];
    if (firstKey) {
      const val = tool.schema.properties[firstKey];
      example[firstKey] = val.default || (val.enum ? val.enum[0] : `<${firstKey}>`);
    }
  }

  return example;
}

function _lateAnswersFileForReplay(projectManager, agentId, sessionId) {
  if (!projectManager || !agentId || !sessionId) return null;
  try {
    const sessionDir = projectManager.getSessionDir(agentId, sessionId);
    return path.join(sessionDir, 'ask-user-late-answers.json');
  } catch {
    return null;
  }
}

function _injectQueuedAskUserAnswers(prompt, projectManager, agentId, sessionId, log = console) {
  const filePath = _lateAnswersFileForReplay(projectManager, agentId, sessionId);
  if (!filePath || !fs.existsSync(filePath)) return prompt;

  let queued;
  try {
    queued = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return prompt;
  }
  if (!Array.isArray(queued) || queued.length === 0) return prompt;

  const lines = [
    '=== RECOVERED ASK-USER ANSWERS ===',
    'The user answered these pending ask-user prompts while no tool call was awaiting input.',
    'Treat these as the newest user inputs before processing the message below.',
    '',
  ];

  for (let i = 0; i < queued.length; i++) {
    const item = queued[i];
    lines.push(`${i + 1}. Question: ${item.question || '(unknown)'}`);
    lines.push(`   Answer: ${typeof item.answer === 'string' ? item.answer : JSON.stringify(item.answer)}`);
  }

  lines.push('', '=== END RECOVERED ASK-USER ANSWERS ===', '', 'Current user message:', prompt);

  try {
    fs.unlinkSync(filePath);
  } catch { /* non-fatal */ }

  log.info(`[_injectQueuedAskUserAnswers] Injected ${queued.length} recovered answer(s) for ${agentId}/${sessionId}`);
  return lines.join('\n');
}

function handleSessionStart(ws, msg, claudeStreamFn, projectManager, agentCLIPool, toolLoader, anthropicClient, log) {
  const sessionId = msg.id || crypto.randomUUID();
  const { prompt, agent, options = {} } = msg;

  if (!prompt) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'prompt is required' });
    return;
  }

  let cliOptions;
  try {
    cliOptions = _resolveAgentOptions(agent, options, projectManager, agentCLIPool, sessionId, toolLoader, log);
  } catch (err) {
    reply(ws, msg, { type: 'session.error', sessionId, error: `Agent error: ${err.message}` });
    return;
  }

  // Assign a CLI session ID and agent ID so tool-cli.js can identify context
  cliOptions.sessionId = sessionId;
  cliOptions.agentId = agent;

  const effectivePrompt = _injectQueuedAskUserAnswers(prompt, projectManager, agent, sessionId, log);
  _startStreamSession(ws, msg, sessionId, effectivePrompt, cliOptions, claudeStreamFn, projectManager, agent, anthropicClient, log);
}

function handleSessionContinue(ws, msg, claudeStreamFn, projectManager, agentCLIPool, toolLoader, anthropicClient, log) {
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
    cliOptions = _resolveAgentOptions(agent, options, projectManager, agentCLIPool, sessionId, toolLoader, log);
  } catch (err) {
    reply(ws, msg, { type: 'session.error', sessionId, error: `Agent error: ${err.message}` });
    return;
  }

  // Use --resume to continue the conversation
  cliOptions.resumeSessionId = sessionId;
  cliOptions.agentId = agent;

  const effectivePrompt = _injectQueuedAskUserAnswers(prompt, projectManager, agent, sessionId, log);
  _startStreamSession(ws, msg, sessionId, effectivePrompt, cliOptions, claudeStreamFn, projectManager, agent, anthropicClient, log);
}

function _startStreamSession(ws, msg, sessionId, prompt, cliOptions, claudeStreamFn, projectManager, agentId, anthropicClient, log) {
  if (ws._csSessions.has(sessionId)) {
    reply(ws, msg, { type: 'session.error', sessionId, error: 'Session ID already active' });
    return;
  }

  let aborted = false;
  ws._csSessions.set(sessionId, { abort: () => { aborted = true; } });

  // Acknowledge immediately so the client can correlate the reqId
  reply(ws, msg, { type: 'session.started', sessionId });

  log.info(`[claudeSocket] Starting session ${sessionId}: "${prompt.slice(0, 80)}..."`);

  // Generate a short title via triage (Haiku) — fire-and-forget so it doesn't
  // block the main stream. The title is pushed to the client as session.title
  // and saved to session metadata.
  let sessionTitle = prompt.slice(0, 100); // fallback: truncated prompt
  const titlePromise = _generateSessionTitle(prompt, anthropicClient, log)
    .then(title => {
      sessionTitle = title;
      if (ws.readyState === ws.OPEN && !aborted) {
        sendJSON(ws, { type: 'session.title', sessionId, title });
      }
    })
    .catch(err => {
      log.warn(`[claudeSocket] Title generation failed, using fallback: ${err.message}`);
    });

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
    .then(async ({ markdown, durationMs }) => {
      // Wait for title generation to finish (it's fast — Haiku) so we save
      // the proper title. If it already resolved, this is a no-op.
      await titlePromise.catch(() => {}); // swallow errors, fallback already set

      // Save session metadata + conversation log
      if (agentId && projectManager) {
        try {
          projectManager.saveSession(agentId, sessionId, {
            title: sessionTitle,
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

// ─── Title generation ─────────────────────────────────────────────────────────

/**
 * Generate a concise session title from the user's first prompt using Haiku.
 * Returns the title string, or falls back to truncated prompt on error.
 *
 * @param {string} prompt     - The user's prompt
 * @param {object} anthropicClient - Anthropic API client (may be null)
 * @param {object} log
 * @returns {Promise<string>}
 */
async function _generateSessionTitle(prompt, anthropicClient, log) {
  if (!anthropicClient) {
    return prompt.slice(0, 100);
  }

  const result = await anthropicClient.message({
    model: 'haiku',
    maxTokens: 40,
    temperature: 0,
    system: 'Generate a short title (max 8 words) that summarizes the user\'s request. Reply with ONLY the title, no quotes, no punctuation at the end, no explanation.',
    messages: [{ role: 'user', content: prompt.slice(0, 500) }],
  });

  const title = (result.text || '').trim().replace(/^["']|["']$/g, '');
  if (!title) return prompt.slice(0, 100);

  log.info(`[claudeSocket] Generated session title: "${title}"`);
  return title;
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
