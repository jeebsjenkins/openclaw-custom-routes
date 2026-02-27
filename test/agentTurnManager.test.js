/**
 * agentTurnManager.test.js — Tests for the automatic agent turn system.
 *
 * Run:  node --test test/agentTurnManager.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMessageBroker } = require('../src/messageBroker');
const { createAgentTurnManager } = require('../src/agentTurnManager');

// ─── Test Helpers ───────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Mock projectManager with session and autoRun support.
 */
function mockProjectManager(agents = []) {
  const agentConfigs = new Map();
  const sessionStore = new Map();

  for (const a of agents) {
    agentConfigs.set(a.id, {
      id: a.id,
      name: a.name || a.id,
      description: a.description || '',
      subscriptions: a.subscriptions || [],
      autoRun: a.autoRun,
    });

    const sessions = a.sessions || [{ id: 'main', isDefault: true }];
    for (const s of sessions) {
      const key = `${a.id}:${s.id}`;
      sessionStore.set(key, {
        id: s.id,
        title: s.title || s.id,
        isDefault: s.isDefault || false,
        subscriptions: s.subscriptions || [],
        autoRun: s.autoRun,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });
    }
  }

  const conversationLogs = [];

  return {
    listAgents: () => agents.map(a => ({ id: a.id, name: a.name || a.id })),
    getAgent: (id) => {
      const c = agentConfigs.get(id);
      if (!c) throw new Error(`Agent not found: ${id}`);
      return { ...c };
    },
    updateAgent: (id, updates) => {
      const c = agentConfigs.get(id);
      if (!c) throw new Error(`Agent not found: ${id}`);
      Object.assign(c, updates);
    },
    listSessions: (agentId) => {
      const sessions = [];
      for (const [key, data] of sessionStore) {
        if (key.startsWith(agentId + ':')) sessions.push({ ...data });
      }
      return sessions;
    },
    getSession: (agentId, sessionId) => {
      const key = `${agentId}:${sessionId}`;
      const data = sessionStore.get(key);
      return data ? { ...data } : null;
    },
    updateSession: (agentId, sessionId, updates) => {
      const key = `${agentId}:${sessionId}`;
      const existing = sessionStore.get(key);
      if (!existing) throw new Error(`Session not found: ${agentId}/${sessionId}`);
      Object.assign(existing, updates, { lastUsedAt: Date.now() });
      return { ...existing };
    },
    appendConversationLog: (agentId, sessionId, entry) => {
      conversationLogs.push({ agentId, sessionId, ...entry });
    },
    _conversationLogs: conversationLogs,
  };
}

/**
 * Mock agentCLIPool that captures CLI calls.
 * The triageResponder and executionResponder control what the "CLI" returns.
 */
function mockAgentCLIPool(opts = {}) {
  const calls = { triage: [], execution: [] };
  const triageResponder = opts.triageResponder || (() => ({ markdown: 'YES — relevant message' }));
  const executionResponder = opts.executionResponder || (() => ({ markdown: 'Processed successfully.' }));

  return {
    calls,
    getAgentCLI: (agentId) => ({
      folder: agentId,
      options: { cwd: `/tmp/${agentId}` },
      query: async (prompt, options = {}) => {
        // Distinguish triage from execution by checking noSessionPersistence flag
        if (options.noSessionPersistence) {
          calls.triage.push({ agentId, prompt, options });
          return triageResponder(agentId, prompt, options);
        } else {
          calls.execution.push({ agentId, prompt, options });
          return executionResponder(agentId, prompt, options);
        }
      },
      stream: async () => ({ markdown: '', durationMs: 0 }),
    }),
  };
}

/**
 * Mock Anthropic API client for triage.
 * The responder controls what the "API" returns.
 */
function mockAnthropicClient(opts = {}) {
  const calls = [];
  const responder = opts.responder || (() => ({ text: 'YES — relevant message' }));

  return {
    calls,
    message: async (params) => {
      calls.push(params);
      return responder(params);
    },
    resolveModel: (m) => m,
  };
}

/**
 * Wait for a condition with timeout.
 */
function waitFor(conditionFn, timeoutMs = 5000, intervalMs = 50) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (conditionFn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

// ─── Config Resolution ─────────────────────────────────────────────────────

describe('_resolveConfig', () => {
  let root, broker, pm, pool, tm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'auto-agent',
        autoRun: { enabled: true, triageModel: 'haiku', debounceMs: 5000 },
        sessions: [
          { id: 'main', isDefault: true },
          { id: 'custom-session', autoRun: { enabled: true, debounceMs: 1000 } },
          { id: 'disabled-session', autoRun: false },
        ],
      },
      {
        id: 'no-auto-agent',
        sessions: [{ id: 'main', isDefault: true }],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
    pool = mockAgentCLIPool();
    tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
  });

  afterEach(() => { tm.stop(); rmrf(root); });

  it('returns agent config when session has no autoRun', () => {
    const config = tm._resolveConfig('auto-agent', 'main');
    assert.equal(config.enabled, true);
    assert.equal(config.debounceMs, 5000);
    assert.equal(config.triageModel, 'haiku');
  });

  it('session config overrides agent config', () => {
    const config = tm._resolveConfig('auto-agent', 'custom-session');
    assert.equal(config.enabled, true);
    assert.equal(config.debounceMs, 1000); // session override
  });

  it('session can disable autoRun even if agent enables it', () => {
    const config = tm._resolveConfig('auto-agent', 'disabled-session');
    assert.equal(config.enabled, false);
  });

  it('returns disabled for agents without autoRun', () => {
    const config = tm._resolveConfig('no-auto-agent', 'main');
    assert.equal(config.enabled, false);
  });

  it('returns disabled for unknown agent', () => {
    const config = tm._resolveConfig('ghost', 'main');
    assert.equal(config.enabled, false);
  });
});

// ─── Debounce & Batching ───────────────────────────────────────────────────

describe('debounce and batching', () => {
  let root, broker, pm, pool, tm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        description: 'Researches topics',
        autoRun: { enabled: true, debounceMs: 200, maxBatchSize: 5 },
        subscriptions: [{ pattern: 'slack/**' }],
        sessions: [
          { id: 'main', isDefault: true },
          { id: 'slack-monitor', autoRun: { enabled: true, debounceMs: 200, maxBatchSize: 5 }, subscriptions: [{ pattern: 'slack/team/#general' }] },
        ],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
    pool = mockAgentCLIPool();
    tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();
  });

  afterEach(() => { tm.stop(); rmrf(root); });

  it('batches multiple messages into one turn after debounce', async () => {
    broker.route('system', 'slack/team/#general', { command: 'msg1', source: 'slack' });
    broker.route('system', 'slack/team/#general', { command: 'msg2', source: 'slack' });
    broker.route('system', 'slack/team/#general', { command: 'msg3', source: 'slack' });

    // Wait for debounce to fire and turn to complete
    await waitFor(() => pool.calls.execution.length > 0, 3000);

    // Should batch into one triage + one execution
    assert.equal(pool.calls.triage.length, 1);
    assert.equal(pool.calls.execution.length, 1);

    // Execution prompt should mention all 3 messages
    const execPrompt = pool.calls.execution[0].prompt;
    assert.ok(execPrompt.includes('3 new inbound message'));
    assert.ok(execPrompt.includes('msg1'));
    assert.ok(execPrompt.includes('msg2'));
    assert.ok(execPrompt.includes('msg3'));
  });

  it('flushes immediately when batch size is reached', async () => {
    // maxBatchSize is 5, send 5 messages rapidly
    for (let i = 0; i < 5; i++) {
      broker.route('system', 'slack/team/#general', { command: `msg${i}`, source: 'slack' });
    }

    // Should flush without waiting for debounce
    await waitFor(() => pool.calls.execution.length > 0, 1000);

    assert.equal(pool.calls.triage.length, 1);
    assert.equal(pool.calls.execution.length, 1);
  });
});

// ─── Triage ─────────────────────────────────────────────────────────────────

describe('triage stage', () => {
  let root, broker, pm;

  afterEach(() => rmrf(root));

  it('skips execution when triage says NO', async () => {
    root = tmpDir();
    pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'noise/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool({
      triageResponder: () => ({ markdown: 'NO — not relevant to this agent' }),
    });
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'noise/test', { command: 'ping', source: 'internal' });

    // Wait for triage to complete
    await waitFor(() => pool.calls.triage.length > 0, 2000);
    // Give extra time for execution (which shouldn't happen)
    await new Promise(r => setTimeout(r, 300));

    assert.equal(pool.calls.triage.length, 1);
    assert.equal(pool.calls.execution.length, 0); // should NOT have executed

    const stats = tm.getStats();
    assert.equal(stats.triageRejected, 1);
    assert.equal(stats.executionCount, 0);

    tm.stop();
  });

  it('runs execution when triage says YES', async () => {
    root = tmpDir();
    pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool({
      triageResponder: () => ({ markdown: 'YES — agent should respond' }),
    });
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);

    assert.equal(pool.calls.triage.length, 1);
    assert.equal(pool.calls.execution.length, 1);

    const stats = tm.getStats();
    assert.equal(stats.triageAccepted, 1);
    assert.equal(stats.executionCount, 1);

    tm.stop();
  });

  it('defaults to running on triage error', async () => {
    root = tmpDir();
    pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool({
      triageResponder: () => { throw new Error('CLI not available'); },
    });
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);

    assert.equal(pool.calls.execution.length, 1); // ran anyway
    const stats = tm.getStats();
    assert.equal(stats.triageErrors, 1);

    tm.stop();
  });
});

// ─── Triage via Anthropic API ────────────────────────────────────────────────

describe('triage via Anthropic API', () => {
  let root;

  afterEach(() => rmrf(root));

  it('uses anthropicClient.message() for triage when client is provided', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const apiClient = mockAnthropicClient({
      responder: () => ({ text: 'YES — agent should respond' }),
    });
    const tm = createAgentTurnManager({
      messageBroker: broker, projectManager: pm, agentCLIPool: pool,
      anthropicClient: apiClient, log: silentLog,
    });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);

    // API client was used for triage, NOT the CLI
    assert.equal(apiClient.calls.length, 1);
    assert.equal(pool.calls.triage.length, 0); // CLI triage not called
    assert.equal(pool.calls.execution.length, 1); // execution still uses CLI

    // Verify API call params
    const apiCall = apiClient.calls[0];
    assert.equal(apiCall.model, 'haiku'); // default triage model
    assert.ok(apiCall.messages[0].content.includes('researcher'));
    assert.ok(apiCall.messages[0].content.includes('hello'));

    tm.stop();
  });

  it('skips execution when API triage says NO', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const apiClient = mockAnthropicClient({
      responder: () => ({ text: 'NO — not relevant' }),
    });
    const tm = createAgentTurnManager({
      messageBroker: broker, projectManager: pm, agentCLIPool: pool,
      anthropicClient: apiClient, log: silentLog,
    });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'noise', source: 'slack' });

    await waitFor(() => apiClient.calls.length > 0, 2000);
    await new Promise(r => setTimeout(r, 300));

    assert.equal(apiClient.calls.length, 1);
    assert.equal(pool.calls.execution.length, 0);

    const stats = tm.getStats();
    assert.equal(stats.triageRejected, 1);

    tm.stop();
  });

  it('defaults to running on API triage error', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const apiClient = mockAnthropicClient({
      responder: () => { throw new Error('API rate limited'); },
    });
    const tm = createAgentTurnManager({
      messageBroker: broker, projectManager: pm, agentCLIPool: pool,
      anthropicClient: apiClient, log: silentLog,
    });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);

    assert.equal(pool.calls.execution.length, 1);
    const stats = tm.getStats();
    assert.equal(stats.triageErrors, 1);

    tm.stop();
  });

  it('falls back to CLI triage when no anthropicClient is provided', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    // No anthropicClient passed — should use CLI fallback
    const tm = createAgentTurnManager({
      messageBroker: broker, projectManager: pm, agentCLIPool: pool,
      log: silentLog,
    });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);

    // CLI was used for triage
    assert.equal(pool.calls.triage.length, 1);
    assert.equal(pool.calls.execution.length, 1);

    tm.stop();
  });
});

// ─── Execution ──────────────────────────────────────────────────────────────

describe('execution stage', () => {
  let root;

  afterEach(() => rmrf(root));

  it('logs auto-turn to conversation history', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);
    // Wait a bit more for conversation log to be written
    await new Promise(r => setTimeout(r, 100));

    const logs = pm._conversationLogs;
    const autoTurnLogs = logs.filter(l => l.type === 'auto-turn');
    const resultLogs = logs.filter(l => l.type === 'auto-turn-result');

    assert.ok(autoTurnLogs.length >= 1);
    assert.ok(resultLogs.length >= 1);
    assert.equal(autoTurnLogs[0].messageCount, 1);
    assert.equal(resultLogs[0].text, 'Processed successfully.');

    tm.stop();
  });

  it('passes resumeSessionId to CLI for session context', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      sessions: [
        { id: 'main', isDefault: true },
        { id: 'slack-mon', autoRun: { enabled: true, debounceMs: 100 }, subscriptions: [{ pattern: 'slack/team/#general' }] },
      ],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);

    const execCall = pool.calls.execution[0];
    assert.equal(execCall.options.resumeSessionId, 'slack-mon');

    tm.stop();
  });
});

// ─── Concurrency ────────────────────────────────────────────────────────────

describe('concurrency control', () => {
  let root;

  afterEach(() => rmrf(root));

  it('queues messages arriving during active turn for re-run', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);

    let executionCount = 0;
    let resolveFirst;
    const pool = mockAgentCLIPool({
      executionResponder: () => {
        executionCount++;
        if (executionCount === 1) {
          // First execution: block until we send a second message
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { markdown: 'Done' };
      },
    });

    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    // Send first message — triggers triage + execution
    broker.route('system', 'slack/team/#general', { command: 'msg1', source: 'slack' });

    // Wait for first execution to start
    await waitFor(() => executionCount === 1, 2000);

    // Send second message while first is still running
    broker.route('system', 'slack/team/#general', { command: 'msg2', source: 'slack' });

    // First turn is blocked — isActive should be true
    assert.ok(tm.isActive('researcher', 'main'));

    // Resolve first execution
    resolveFirst({ markdown: 'First done' });

    // Wait for the re-run to happen
    await waitFor(() => executionCount === 2, 3000);

    assert.equal(pool.calls.execution.length, 2);

    tm.stop();
  });
});

// ─── No autoRun ─────────────────────────────────────────────────────────────

describe('no autoRun configured', () => {
  let root;

  afterEach(() => rmrf(root));

  it('does not trigger turns for agents without autoRun', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      // No autoRun set
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    // Wait to make sure nothing fires
    await new Promise(r => setTimeout(r, 500));

    assert.equal(pool.calls.triage.length, 0);
    assert.equal(pool.calls.execution.length, 0);

    tm.stop();
  });
});

// ─── Manual Trigger ─────────────────────────────────────────────────────────

describe('triggerTurn (manual)', () => {
  let root;

  afterEach(() => rmrf(root));

  it('bypasses triage and goes straight to execution', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      // autoRun not needed for manual trigger
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });

    const messages = [{
      id: 'test-123',
      from: 'system',
      path: 'slack/team/#general',
      command: 'hello',
      payload: { text: 'test message' },
      source: 'slack',
      timestamp: Date.now(),
    }];

    const result = await tm.triggerTurn('researcher', 'main', messages);

    assert.equal(result.executed, true);
    assert.equal(pool.calls.triage.length, 0); // no triage
    assert.equal(pool.calls.execution.length, 1);

    tm.stop();
  });
});

// ─── onRoute hook in broker ─────────────────────────────────────────────────

describe('broker onRoute hook', () => {
  let root;

  afterEach(() => rmrf(root));

  it('fires callback on successful delivery', () => {
    root = tmpDir();
    const pm = mockProjectManager([{ id: 'researcher' }]);
    const broker = createMessageBroker(root, pm, silentLog);

    const received = [];
    broker.onRoute((result) => received.push(result));

    broker.send('system', 'researcher', { command: 'test' });

    assert.equal(received.length, 1);
    assert.ok(received[0].delivered);
    assert.ok(received[0].deliveredTo.includes('researcher'));
  });

  it('does not fire on unmatched delivery', () => {
    root = tmpDir();
    const pm = mockProjectManager([{ id: 'researcher' }]);
    const broker = createMessageBroker(root, pm, silentLog);

    const received = [];
    broker.onRoute((result) => received.push(result));

    broker.route('system', 'unknown/path', { command: 'test' });

    assert.equal(received.length, 0);
  });

  it('unsubscribe function works', () => {
    root = tmpDir();
    const pm = mockProjectManager([{ id: 'researcher' }]);
    const broker = createMessageBroker(root, pm, silentLog);

    const received = [];
    const unsub = broker.onRoute((result) => received.push(result));

    broker.send('system', 'researcher', { command: 'first' });
    unsub();
    broker.send('system', 'researcher', { command: 'second' });

    assert.equal(received.length, 1);
  });
});

// ─── Stats ──────────────────────────────────────────────────────────────────

describe('getStats', () => {
  let root;

  afterEach(() => rmrf(root));

  it('tracks triage and execution counts', async () => {
    root = tmpDir();
    const pm = mockProjectManager([{
      id: 'researcher',
      autoRun: { enabled: true, debounceMs: 100 },
      subscriptions: [{ pattern: 'slack/**' }],
    }]);
    const broker = createMessageBroker(root, pm, silentLog);
    const pool = mockAgentCLIPool();
    const tm = createAgentTurnManager({ messageBroker: broker, projectManager: pm, agentCLIPool: pool, log: silentLog });
    tm.start();

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    await waitFor(() => pool.calls.execution.length > 0, 2000);
    await new Promise(r => setTimeout(r, 100));

    const stats = tm.getStats();
    assert.equal(stats.triageCount, 1);
    assert.equal(stats.triageAccepted, 1);
    assert.equal(stats.executionCount, 1);
    assert.equal(stats.messagesProcessed, 1);

    tm.stop();
  });
});
