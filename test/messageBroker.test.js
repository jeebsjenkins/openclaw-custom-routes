/**
 * messageBroker.test.js — Tests for the unified path-based message broker.
 *
 * Run:  node --test test/messageBroker.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMessageBroker } = require('../src/messageBroker');

// ─── Test Helpers ───────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal projectManager mock */
function mockProjectManager(agents = []) {
  const configs = new Map();

  for (const a of agents) {
    configs.set(a.id, {
      id: a.id,
      name: a.name || a.id,
      subscriptions: a.subscriptions || [],
    });
  }

  return {
    listAgents: () => agents.map(a => ({ id: a.id, name: a.name || a.id })),

    getAgent: (id) => {
      const c = configs.get(id);
      if (!c) throw new Error(`Agent not found: ${id}`);
      return { ...c };
    },

    updateAgent: (id, updates) => {
      const c = configs.get(id);
      if (!c) throw new Error(`Agent not found: ${id}`);
      Object.assign(c, updates);
    },
  };
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Path Matching ──────────────────────────────────────────────────────────

describe('pathMatches', () => {
  let root, broker;

  beforeEach(() => {
    root = tmpDir();
    broker = createMessageBroker(root, mockProjectManager(), silentLog);
  });

  afterEach(() => rmrf(root));

  it('matches exact paths', () => {
    assert.ok(broker.pathMatches('agent/researcher', 'agent/researcher'));
    assert.ok(broker.pathMatches('slack/test/#general', 'slack/test/#general'));
  });

  it('rejects non-matching exact paths', () => {
    assert.ok(!broker.pathMatches('agent/researcher', 'agent/writer'));
    assert.ok(!broker.pathMatches('agent/researcher', 'agent/researcher/sub'));
  });

  it('matches single-segment wildcard (*)', () => {
    assert.ok(broker.pathMatches('agent/*', 'agent/researcher'));
    assert.ok(broker.pathMatches('slack/*/##general', 'slack/team/##general'));
  });

  it('single wildcard does not span segments', () => {
    assert.ok(!broker.pathMatches('agent/*', 'agent/a/b'));
  });

  it('matches multi-segment wildcard (**)', () => {
    assert.ok(broker.pathMatches('agent/**', 'agent/researcher'));
    assert.ok(broker.pathMatches('agent/**', 'agent/a/b/c'));
    assert.ok(broker.pathMatches('**', 'anything/at/all'));
  });

  it('** matches zero segments', () => {
    assert.ok(broker.pathMatches('agent/**', 'agent'));
  });

  it('handles leading/trailing slashes', () => {
    assert.ok(broker.pathMatches('/agent/researcher/', 'agent/researcher'));
    assert.ok(broker.pathMatches('agent/researcher', '/agent/researcher/'));
  });

  it('mixed wildcards', () => {
    assert.ok(broker.pathMatches('slack/*/*', 'slack/workspace/#general'));
    assert.ok(broker.pathMatches('slack/*/*', 'slack/workspace/@user'));
    assert.ok(!broker.pathMatches('slack/*/*', 'slack/workspace/#general/thread'));
  });
});

// ─── Auto-Subscriptions & Direct Messaging ──────────────────────────────────

describe('auto-subscriptions', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      { id: 'researcher' },
      { id: 'writer' },
      { id: 'reviewer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('agent receives messages sent to agent/{id}', () => {
    const result = broker.send('writer', 'researcher', { command: 'analyze', payload: { topic: 'AI' } });

    assert.ok(result.delivered);
    assert.deepStrictEqual(result.deliveredTo, ['researcher']);
    assert.equal(result.path, 'agent/researcher');
    assert.equal(result.command, 'analyze');
    assert.equal(result.from, 'writer');
  });

  it('receive() returns pending messages and marks delivered', () => {
    broker.send('writer', 'researcher', { command: 'task1' });
    broker.send('reviewer', 'researcher', { command: 'task2' });

    const msgs = broker.receive('researcher');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].command, 'task1');
    assert.equal(msgs[1].command, 'task2');
    assert.ok(msgs.every(m => m.status === 'delivered'));

    // Second receive should return nothing (already delivered)
    const msgs2 = broker.receive('researcher');
    assert.equal(msgs2.length, 0);
  });

  it('send() returns a valid message structure', () => {
    const result = broker.send('writer', 'researcher', { command: 'ping', payload: { data: 42 } });

    assert.ok(result.id);
    assert.equal(result.from, 'writer');
    assert.equal(result.path, 'agent/researcher');
    assert.equal(result.command, 'ping');
    assert.deepStrictEqual(result.payload, { data: 42 });
    assert.equal(result.source, 'internal');
    assert.equal(result.status, 'pending');
    assert.ok(result.timestamp > 0);
    assert.equal(result.unmatched, false);
  });
});

// ─── route() ────────────────────────────────────────────────────────────────

describe('route()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      { id: 'researcher', subscriptions: [{ pattern: 'slack/test/#general' }] },
      { id: 'writer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('routes to agents with matching custom subscriptions', () => {
    const result = broker.route('system', 'slack/test/#general', {
      command: 'new_message',
      payload: { text: 'hello' },
      source: 'slack',
      externalId: 'ts-1234',
    });

    assert.ok(result.delivered);
    assert.deepStrictEqual(result.deliveredTo, ['researcher']);
    assert.equal(result.source, 'slack');
    assert.equal(result.externalId, 'ts-1234');
  });

  it('unmatched paths go to dead-letter', () => {
    const result = broker.route('system', 'email/nobody@test.com/sender@test.com', {
      command: 'incoming',
    });

    assert.ok(!result.delivered);
    assert.ok(result.unmatched);
    assert.deepStrictEqual(result.deliveredTo, []);

    const deadLetters = broker.getUnmatched();
    assert.equal(deadLetters.length, 1);
    assert.equal(deadLetters[0].path, 'email/nobody@test.com/sender@test.com');
    assert.equal(deadLetters[0].reason, 'no_subscribers');
  });

  it('throws on empty path', () => {
    assert.throws(() => broker.route('writer', '', {}), /path is required/);
  });
});

// ─── broadcast() ────────────────────────────────────────────────────────────

describe('broadcast()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      { id: 'researcher' },
      { id: 'writer' },
      { id: 'reviewer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('delivers to all agents except sender', () => {
    const result = broker.broadcast('writer', { command: 'announce', payload: { text: 'hi all' } });

    assert.ok(result.delivered);
    assert.ok(result.deliveredTo.includes('researcher'));
    assert.ok(result.deliveredTo.includes('reviewer'));
    assert.ok(!result.deliveredTo.includes('writer'));
    assert.equal(result.deliveredTo.length, 2);
  });

  it('messages are receivable by each recipient', () => {
    broker.broadcast('writer', { command: 'ping' });

    const researcherMsgs = broker.receive('researcher');
    const reviewerMsgs = broker.receive('reviewer');
    const writerMsgs = broker.receive('writer');

    assert.equal(researcherMsgs.length, 1);
    assert.equal(reviewerMsgs.length, 1);
    assert.equal(writerMsgs.length, 0); // sender excluded
  });
});

// ─── Custom Subscriptions ───────────────────────────────────────────────────

describe('subscribe / unsubscribe', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      { id: 'researcher' },
      { id: 'writer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('subscribe adds a pattern and persists it', () => {
    const result = broker.subscribe('writer', 'slack/team/#random');

    assert.ok(result.success);
    assert.equal(result.pattern, 'slack/team/#random');

    // Verify persistence
    const agent = pm.getAgent('writer');
    assert.ok(agent.subscriptions.some(s => s.pattern === 'slack/team/#random'));
  });

  it('subscribed agent receives routed messages', () => {
    broker.subscribe('writer', 'slack/team/#random');

    const result = broker.route('system', 'slack/team/#random', {
      command: 'chat',
      source: 'slack',
    });

    assert.ok(result.delivered);
    assert.deepStrictEqual(result.deliveredTo, ['writer']);
  });

  it('unsubscribe removes the pattern', () => {
    broker.subscribe('writer', 'email/**');
    broker.unsubscribe('writer', 'email/**');

    const result = broker.route('system', 'email/to@test.com/from@test.com', {
      command: 'incoming',
    });

    assert.ok(!result.delivered);
    assert.ok(result.unmatched);
  });

  it('cannot unsubscribe from auto-subscription', () => {
    assert.throws(
      () => broker.unsubscribe('writer', 'agent/writer'),
      /Cannot unsubscribe from auto-subscription/,
    );
  });

  it('subscribing to own auto-subscription pattern is a no-op', () => {
    const result = broker.subscribe('writer', 'agent/writer');
    assert.ok(result.success);
    assert.equal(result.note, 'auto-subscribed');
  });

  it('getSubscriptions returns custom subscriptions only', () => {
    broker.subscribe('researcher', 'slack/**');
    broker.subscribe('researcher', 'webhook/github/*');

    const subs = broker.getSubscriptions('researcher');
    assert.equal(subs.length, 2);

    const patterns = subs.map(s => s.pattern);
    assert.ok(patterns.includes('slack/**'));
    assert.ok(patterns.includes('webhook/github/*'));
  });

  it('wildcard subscription matches multiple paths', () => {
    broker.subscribe('writer', 'slack/*/*');

    const r1 = broker.route('system', 'slack/team1/#general', { command: 'msg' });
    const r2 = broker.route('system', 'slack/team2/#random', { command: 'msg' });

    assert.ok(r1.delivered);
    assert.ok(r2.delivered);
    assert.ok(r1.deliveredTo.includes('writer'));
    assert.ok(r2.deliveredTo.includes('writer'));
  });

  it('multiple agents can subscribe to the same pattern', () => {
    broker.subscribe('researcher', 'slack/team/#general');
    broker.subscribe('writer', 'slack/team/#general');

    const result = broker.route('system', 'slack/team/#general', { command: 'msg' });

    assert.ok(result.delivered);
    assert.equal(result.deliveredTo.length, 2);
    assert.ok(result.deliveredTo.includes('researcher'));
    assert.ok(result.deliveredTo.includes('writer'));
  });
});

// ─── listen() — Real-time EventEmitter ──────────────────────────────────────

describe('listen()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([{ id: 'researcher' }, { id: 'writer' }]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('fires callback on direct message', () => {
    const received = [];
    broker.listen('researcher', (msg) => received.push(msg));

    broker.send('writer', 'researcher', { command: 'hello' });

    assert.equal(received.length, 1);
    assert.equal(received[0].command, 'hello');
    assert.equal(received[0].from, 'writer');
  });

  it('fires callback on broadcast', () => {
    const received = [];
    broker.listen('researcher', (msg) => received.push(msg));

    broker.broadcast('writer', { command: 'announce' });

    assert.equal(received.length, 1);
    assert.equal(received[0].command, 'announce');
  });

  it('unsubscribe function stops delivery', () => {
    const received = [];
    const unsub = broker.listen('researcher', (msg) => received.push(msg));

    broker.send('writer', 'researcher', { command: 'first' });
    unsub();
    broker.send('writer', 'researcher', { command: 'second' });

    assert.equal(received.length, 1);
    assert.equal(received[0].command, 'first');
  });
});

// ─── history() ──────────────────────────────────────────────────────────────

describe('history()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([{ id: 'researcher' }, { id: 'writer' }]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('returns all messages for an agent', () => {
    broker.send('writer', 'researcher', { command: 'task1' });
    broker.send('writer', 'researcher', { command: 'task2' });
    broker.send('writer', 'researcher', { command: 'task3' });

    const msgs = broker.history('researcher');
    assert.equal(msgs.length, 3);
  });

  it('returns messages in reverse chronological order', () => {
    broker.send('writer', 'researcher', { command: 'first' });
    broker.send('writer', 'researcher', { command: 'second' });

    const msgs = broker.history('researcher');
    // Most recent first
    assert.ok(msgs[0].timestamp >= msgs[1].timestamp);
  });

  it('respects limit option', () => {
    for (let i = 0; i < 10; i++) {
      broker.send('writer', 'researcher', { command: `task${i}` });
    }

    const msgs = broker.history('researcher', { limit: 3 });
    assert.equal(msgs.length, 3);
  });

  it('filters by time range', () => {
    const now = Date.now();

    broker.send('writer', 'researcher', { command: 'old' });
    broker.send('writer', 'researcher', { command: 'new' });

    const msgs = broker.history('researcher', { fromTime: now - 1000, toTime: now + 60000 });
    assert.ok(msgs.length >= 2);
  });

  it('returns empty array for agent with no messages', () => {
    const msgs = broker.history('writer');
    assert.equal(msgs.length, 0);
  });
});

// ─── Dead-letter / Unmatched ────────────────────────────────────────────────

describe('dead-letter', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([{ id: 'researcher' }]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('getUnmatched returns dead-letter messages', () => {
    broker.route('system', 'unknown/path', { command: 'lost' });
    broker.route('system', 'another/unknown', { command: 'also_lost' });

    const unmatched = broker.getUnmatched();
    assert.equal(unmatched.length, 2);
  });

  it('clearUnmatched empties the dead-letter log', () => {
    broker.route('system', 'nowhere/fast', { command: 'gone' });

    const before = broker.getUnmatched();
    assert.equal(before.length, 1);

    const result = broker.clearUnmatched();
    assert.ok(result.cleared);

    const after = broker.getUnmatched();
    assert.equal(after.length, 0);
  });

  it('getUnmatched respects limit', () => {
    for (let i = 0; i < 5; i++) {
      broker.route('system', `gone/${i}`, { command: 'lost' });
    }

    const unmatched = broker.getUnmatched({ limit: 2 });
    assert.equal(unmatched.length, 2);
  });
});

// ─── rebuildIndex() ─────────────────────────────────────────────────────────

describe('rebuildIndex()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      { id: 'researcher', subscriptions: [{ pattern: 'slack/team/#general' }] },
      { id: 'writer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('rebuilds from projectManager state', () => {
    // Researcher already has slack sub from config
    const r1 = broker.route('system', 'slack/team/#general', { command: 'test' });
    assert.ok(r1.delivered);

    // Manually update the config to add a sub for writer
    pm.updateAgent('writer', {
      subscriptions: [{ pattern: 'email/**' }],
    });

    broker.rebuildIndex();

    const r2 = broker.route('system', 'email/to@test.com/from@test.com', { command: 'test' });
    assert.ok(r2.delivered);
    assert.ok(r2.deliveredTo.includes('writer'));
  });
});

// ─── Self-messaging ─────────────────────────────────────────────────────────

describe('self-messaging', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([{ id: 'researcher' }, { id: 'writer' }]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('agent can send a message to itself', () => {
    const result = broker.send('researcher', 'researcher', { command: 'self-note' });

    assert.ok(result.delivered);
    assert.deepStrictEqual(result.deliveredTo, ['researcher']);

    const msgs = broker.receive('researcher');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].command, 'self-note');
  });
});

// ─── External source metadata ───────────────────────────────────────────────

describe('external source metadata', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      { id: 'researcher', subscriptions: [{ pattern: 'slack/**' }] },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('preserves source and externalId through the pipeline', () => {
    broker.route('slack-bridge', 'slack/team/#general', {
      command: 'new_message',
      payload: { text: 'hello from slack', user: 'U123' },
      source: 'slack',
      externalId: '1234567890.123456',
    });

    const msgs = broker.receive('researcher');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].source, 'slack');
    assert.equal(msgs[0].externalId, '1234567890.123456');
    assert.equal(msgs[0].payload.text, 'hello from slack');
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('persistence', () => {
  let root, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([{ id: 'researcher' }, { id: 'writer' }]);
  });

  afterEach(() => rmrf(root));

  it('messages survive broker recreation', () => {
    const broker1 = createMessageBroker(root, pm, silentLog);
    broker1.send('writer', 'researcher', { command: 'persistent' });

    // Create a new broker instance reading the same directory
    const broker2 = createMessageBroker(root, pm, silentLog);
    const msgs = broker2.history('researcher');

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].command, 'persistent');
  });

  it('creates .messages directory', () => {
    createMessageBroker(root, pm, silentLog);
    assert.ok(fs.existsSync(path.join(root, '.messages')));
  });

  it('message files are JSONL format', () => {
    const broker = createMessageBroker(root, pm, silentLog);
    broker.send('writer', 'researcher', { command: 'a' });
    broker.send('writer', 'researcher', { command: 'b' });

    const filePath = path.join(root, '.messages', 'agent--researcher.jsonl');
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');

    assert.equal(lines.length, 2);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
    assert.doesNotThrow(() => JSON.parse(lines[1]));
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([{ id: 'researcher' }]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('route to non-existent agent goes to dead-letter', () => {
    const result = broker.route('researcher', 'agent/does-not-exist', { command: 'lost' });
    assert.ok(!result.delivered);
    assert.ok(result.unmatched);
  });

  it('receive with no messages returns empty array', () => {
    const msgs = broker.receive('researcher');
    assert.deepStrictEqual(msgs, []);
  });

  it('defaults command to "message"', () => {
    const result = broker.send('researcher', 'researcher', {});
    assert.equal(result.command, 'message');
  });

  it('defaults payload to empty object', () => {
    const result = broker.send('researcher', 'researcher', { command: 'test' });
    assert.deepStrictEqual(result.payload, {});
  });

  it('defaults source to "internal"', () => {
    const result = broker.send('researcher', 'researcher', { command: 'test' });
    assert.equal(result.source, 'internal');
  });

  it('throws if projectRoot is missing', () => {
    assert.throws(() => createMessageBroker(null, pm, silentLog), /projectRoot is required/);
  });

  it('throws if projectManager is missing', () => {
    assert.throws(() => createMessageBroker(root, null, silentLog), /projectManager is required/);
  });

  it('getSubscriptions for agent with none returns empty array', () => {
    const subs = broker.getSubscriptions('researcher');
    assert.deepStrictEqual(subs, []);
  });
});
