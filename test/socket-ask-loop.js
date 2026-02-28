#!/usr/bin/env node
'use strict';

require('dotenv').config();
const WebSocket = require('ws');

function parseArgs(argv) {
  const out = {
    host: process.env.CLAUDE_SOCKET_HOST || '127.0.0.1',
    // Pin test default to 3101 to avoid collision with HTTP server on 3100.
    port: 3101,
    agent: 'main',
    prompt: 'ask me a question with a prompt',
    answer: process.env.ASK_USER_ANSWER || 'This is my test answer.',
    permissionMode: 'bypassPermissions',
    timeoutMs: 120000,
    sessionId: null,
    query: null,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--agent') out.agent = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--answer') out.answer = argv[++i];
    else if (a === '--permission-mode') out.permissionMode = argv[++i];
    else if (a === '--timeout') out.timeoutMs = Math.max(1000, parseInt(argv[++i], 10) * 1000);
    else if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--query') out.query = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }

  return out;
}

function printUsage() {
  console.log(
    [
      'Usage: node test/socket-ask-loop.js [options]',
      '',
      'Options:',
      '  --host <host>         Socket host (default: 127.0.0.1)',
      '  --port <port>         Socket port (default: 3101)',
      '  --agent <id>          Agent id (default: main)',
      '  --prompt <text>       Prompt to run',
      '  --answer <text>       Auto-answer for ask-user',
      '  --permission-mode <mode> Claude permission mode (default: bypassPermissions)',
      '  --session-id <uuid>   Force session id',
      '  --query <text>        Log query override (defaults to session id)',
      '  --timeout <seconds>   Overall timeout (default: 120)',
      '  --quiet               Reduce event output',
      '',
      'Env:',
      '  CLAUDE_SOCKET_TOKEN   Required auth token',
      '  ASK_USER_ANSWER       Optional default answer',
    ].join('\n')
  );
}

function log(...args) {
  console.log('[socket-ask-loop]', ...args);
}

async function run() {
  const opts = parseArgs(process.argv);
  const token = process.env.CLAUDE_SOCKET_TOKEN;
  if (!token) {
    throw new Error('CLAUDE_SOCKET_TOKEN is required');
  }

  const url = `ws://${opts.host}:${opts.port}`;
  const ws = new WebSocket(url);
  const reqMap = new Map();
  let reqSeq = 1;
  let runSessionId = opts.sessionId || null;
  let sawAskUser = false;
  let sawAskUserQuestionTool = false;
  let done = false;

  const closePromise = new Promise((resolve) => {
    ws.on('close', () => resolve());
  });

  const timeout = setTimeout(() => {
    if (!done) {
      log(`Timeout after ${opts.timeoutMs}ms`);
      ws.close();
      process.exitCode = 2;
    }
  }, opts.timeoutMs);

  function sendRaw(payload) {
    ws.send(JSON.stringify(payload));
  }

  function sendReq(payload, waitMs = 30000) {
    const reqId = `t${reqSeq++}`;
    payload.reqId = reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reqMap.delete(reqId);
        reject(new Error(`Request timeout for ${payload.type}`));
      }, waitMs);
      reqMap.set(reqId, { resolve, reject, timer });
      sendRaw(payload);
    });
  }

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
    process.exitCode = 1;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.reqId && reqMap.has(msg.reqId)) {
      const pending = reqMap.get(msg.reqId);
      reqMap.delete(msg.reqId);
      clearTimeout(pending.timer);
      pending.resolve(msg);
      return;
    }

    if (!opts.quiet) {
      if (
        msg.type === 'session.text' ||
        msg.type === 'session.thinking' ||
        msg.type === 'session.event' ||
        msg.type === 'session.tool_use' ||
        msg.type === 'session.result' ||
        msg.type === 'session.done' ||
        msg.type === 'ask-user'
      ) {
        console.log(JSON.stringify(msg));
      }
    }

    if (msg.type === 'session.started' && !runSessionId) {
      runSessionId = msg.sessionId;
      log(`session.started ${runSessionId}`);
    }

    if (msg.type === 'ask-user') {
      sawAskUser = true;
      const answer = opts.answer;
      log(`ask-user received -> responding with: "${answer}"`);
      sendRaw({
        type: 'ask-user.response',
        questionId: msg.questionId,
        answer,
      });
    }

    if (msg.type === 'session.tool_use' && msg.name === 'AskUserQuestion') {
      sawAskUserQuestionTool = true;
      log('Observed built-in AskUserQuestion tool usage');
    }

    if (msg.type === 'session.error') {
      done = true;
      log(`session.error: ${msg.error}`);
      ws.close();
      process.exitCode = 1;
    }

    if (msg.type === 'session.done') {
      done = true;
      log(`session.done in ${msg.durationMs}ms`);
      ws.close();
    }
  });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  log(`connected ${url}`);

  sendRaw({ type: 'auth', token });
  const auth = await waitForReqless(ws, (m) => m.type === 'auth.ok' || m.type === 'auth.error', 8000);
  if (auth.type !== 'auth.ok') {
    throw new Error(`Auth failed: ${auth.error || 'unknown'}`);
  }
  log('auth.ok');

  const listRes = await sendReq({ type: 'agent.list' });
  if (listRes.type.endsWith('.error')) throw new Error(`agent.list failed: ${listRes.error}`);
  log(`agents: ${(listRes.agents || []).map(a => a.id).join(', ') || '(none)'}`);

  const startType = runSessionId ? 'session.continue' : 'session.start';
  const startReq = {
    type: startType,
    agent: opts.agent,
    prompt: opts.prompt,
    options: {
      permissionMode: opts.permissionMode,
    },
  };
  if (runSessionId) startReq.sessionId = runSessionId;
  if (opts.sessionId && !runSessionId) startReq.id = opts.sessionId;
  const started = await sendReq(startReq, Math.min(opts.timeoutMs, 120000));
  if (started.type === 'session.error') throw new Error(started.error || 'session.start failed');
  if (started.type !== 'session.started') {
    throw new Error(`Unexpected start response: ${started.type}`);
  }
  runSessionId = started.sessionId;
  log(`started session ${runSessionId}`);

  await closePromise;
  clearTimeout(timeout);

  // Reconnect for post-run queries (the prior socket may have closed after done).
  let logs = { results: [] };
  let history = { entries: [] };
  try {
    const ws2 = await connectAndAuth(url, token, { retries: 10, retryDelayMs: 500 });
    const sendReq2 = mkSendReq(ws2);

    const query = opts.query || runSessionId;
    logs = await sendReq2({
      type: 'logs.search',
      options: {
        query,
        limit: 25,
      },
    });

    history = await sendReq2({
      type: 'conversation.history',
      agent: opts.agent,
      sessionId: runSessionId,
    });

    ws2.close();
  } catch (err) {
    log(`Post-run log query skipped: ${err.message}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({
    agent: opts.agent,
    sessionId: runSessionId,
    sawAskUser,
    sawAskUserQuestionTool,
    logsMatchCount: (logs.results || []).length,
    historyCount: (history.entries || []).length,
  }, null, 2));

  if ((logs.results || []).length > 0) {
    console.log('\n=== LOG MATCHES (first 5) ===');
    for (const row of logs.results.slice(0, 5)) {
      console.log(`${row.agentId || '?'} ${row.sessionId || '?'} ${row.role || '?'} ${row.type || '?'} :: ${(row.text || '').slice(0, 180)}`);
    }
  }

  if (sawAskUserQuestionTool) {
    process.exitCode = 3;
    return;
  }
  if (!sawAskUser) {
    process.exitCode = 4;
  }
}

function waitForReqless(ws, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('Timed out waiting for socket message'));
    }, timeoutMs);
    function onMsg(raw) {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.reqId) return;
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}

function mkSendReq(ws) {
  let seq = 1;
  const pending = new Map();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg.reqId) return;
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    clearTimeout(p.timer);
    p.resolve(msg);
  });

  return function sendReq(payload, waitMs = 30000) {
    const reqId = `q${seq++}`;
    payload.reqId = reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`Request timeout for ${payload.type}`));
      }, waitMs);
      pending.set(reqId, { resolve, reject, timer });
      ws.send(JSON.stringify(payload));
    });
  };
}

async function connectAndAuth(url, token, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 1;
  const retryDelayMs = Number.isInteger(opts.retryDelayMs) ? opts.retryDelayMs : 0;
  let lastErr;

  for (let i = 0; i < retries; i++) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'auth', token }));
      const auth = await waitForReqless(ws, (m) => m.type === 'auth.ok' || m.type === 'auth.error', 8000);
      if (auth.type !== 'auth.ok') throw new Error(`Auth failed on reconnect: ${auth.error || 'unknown'}`);
      return ws;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1 && retryDelayMs > 0) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }

  throw lastErr || new Error('connectAndAuth failed');
}

run().catch((err) => {
  console.error(`[socket-ask-loop] ERROR: ${err.message}`);
  process.exit(1);
});
