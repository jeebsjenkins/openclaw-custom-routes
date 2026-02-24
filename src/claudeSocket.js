/**
 * claudeSocket.js — WebSocket server for mobile Claude CLI access
 *
 * Loosely coupled: depends only on `ws` and a caller-provided claudeStreamFn.
 * Can be extracted to a standalone project by copying this file.
 *
 * Message protocol (JSON over WebSocket):
 *
 * Client → Server:
 *   { type: "auth",          token }                          — authenticate
 *   { type: "session.start", id, prompt, options? }           — start streaming session
 *   { type: "session.abort", sessionId }                      — kill active session
 *   { type: "ping" }                                          — keepalive
 *
 * Server → Client:
 *   { type: "auth.ok" }                                       — authenticated
 *   { type: "auth.error",      error }                        — bad token
 *   { type: "session.thinking", sessionId, text }             — thinking delta
 *   { type: "session.text",     sessionId, text }             — text delta
 *   { type: "session.result",   sessionId, text, durationMs } — final result
 *   { type: "session.error",    sessionId, error }            — error / timeout
 *   { type: "session.event",    sessionId, data }             — raw CLI event
 *   { type: "pong" }                                          — keepalive response
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Start the Claude WebSocket server.
 *
 * @param {object} opts
 * @param {number}   opts.port           - Port to listen on (default 3101)
 * @param {string}   [opts.host]         - Bind address (default 0.0.0.0)
 * @param {string}   opts.token          - Shared secret for auth
 * @param {function} opts.claudeStreamFn - (prompt, options, onEvent) => Promise<{markdown, durationMs}>
 * @param {object}   [opts.log]          - Logger with info/warn/error methods
 * @returns {{ wss: WebSocketServer, close: () => void }}
 */
function start(opts = {}) {
  const {
    port = 3101,
    host = '0.0.0.0',
    token,
    claudeStreamFn,
    log = console,
  } = opts;

  if (!token) {
    throw new Error('claudeSocket: token is required');
  }
  if (typeof claudeStreamFn !== 'function') {
    throw new Error('claudeSocket: claudeStreamFn is required');
  }

  const wss = new WebSocketServer({ port, host });

  // Heartbeat to detect dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._csAlive === false) {
        ws.terminate();
        continue;
      }
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
    ws._csSessions = new Map(); // sessionId → { abort: Function }

    ws.on('pong', () => { ws._csAlive = true; });

    // Auth timeout — disconnect if not authenticated within AUTH_TIMEOUT_MS
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

      // --- Auth gate ---
      if (!ws._csAuthed) {
        if (msg.type === 'auth') {
          if (msg.token && timingSafeEqual(msg.token, token)) {
            ws._csAuthed = true;
            clearTimeout(authTimer);
            sendJSON(ws, { type: 'auth.ok' });
            log.info(`[claudeSocket] Client ${clientAddr} authenticated`);
          } else {
            sendJSON(ws, { type: 'auth.error', error: 'Invalid token' });
            ws.close(4003, 'Invalid token');
          }
        } else {
          sendJSON(ws, { type: 'auth.error', error: 'Must authenticate first' });
        }
        return;
      }

      // --- Authenticated message handling ---
      switch (msg.type) {
        case 'ping':
          sendJSON(ws, { type: 'pong' });
          break;

        case 'session.start':
          handleSessionStart(ws, msg, claudeStreamFn, log);
          break;

        case 'session.abort':
          handleSessionAbort(ws, msg, log);
          break;

        default:
          sendJSON(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      // Kill any active sessions for this connection
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

  return { wss, close };
}

// ─── Session handlers ─────────────────────────────────────────────────────────

function handleSessionStart(ws, msg, claudeStreamFn, log) {
  const sessionId = msg.id || crypto.randomUUID();
  const { prompt, options = {} } = msg;

  if (!prompt) {
    sendJSON(ws, { type: 'session.error', sessionId, error: 'prompt is required' });
    return;
  }

  if (ws._csSessions.has(sessionId)) {
    sendJSON(ws, { type: 'session.error', sessionId, error: 'Session ID already in use' });
    return;
  }

  let aborted = false;
  const sessionEntry = {
    abort: () => { aborted = true; },
  };
  ws._csSessions.set(sessionId, sessionEntry);

  log.info(`[claudeSocket] Starting session ${sessionId}: "${prompt.slice(0, 80)}..."`);

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
      default:
        sendJSON(ws, { type: 'session.event', sessionId, data });
    }
  };

  claudeStreamFn(prompt, options, onEvent)
    .then(({ markdown, durationMs }) => {
      if (ws.readyState === ws.OPEN && !aborted) {
        sendJSON(ws, { type: 'session.result', sessionId, text: markdown, durationMs });
      }
    })
    .catch((err) => {
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
    sendJSON(ws, { type: 'error', error: 'sessionId is required' });
    return;
  }

  const session = ws._csSessions.get(sessionId);
  if (!session) {
    sendJSON(ws, { type: 'error', error: `No active session: ${sessionId}` });
    return;
  }

  log.info(`[claudeSocket] Aborting session ${sessionId}`);
  session.abort();
  ws._csSessions.delete(sessionId);
  sendJSON(ws, { type: 'session.aborted', sessionId });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/**
 * Constant-time string comparison to prevent timing attacks on token auth.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { start };
