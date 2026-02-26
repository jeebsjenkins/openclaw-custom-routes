/**
 * sessionSubscriptions.test.js — Tests for session-level broker subscriptions.
 *
 * Run:  node --test test/sessionSubscriptions.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMessageBroker } = require('../src/messageBroker');

// ─── Test Helpers ───────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Mock projectManager with session support.
 * Agents have sessions; sessions can have subscriptions.
 */
function mockProjectManager(agents = []) {
  const agentConfigs = new Map();
  const sessionStore = new Map(); // "agentId:sessionId" → session data

  for (const a of agents) {
    agentConfigs.set(a.id, {
      id: a.id,
      name: a.name || a.id,
      subscriptions: a.subscriptions || [],
    });

    // Create default sessions
    const sessions = a.sessions || [{ id: 'main', isDefault: true, subscriptions: [] }];
    for (const s of sessions) {
      const key = `${a.id}:${s.id}`;
      sessionStore.set(key, {
        id: s.id,
        title: s.title || s.id,
        isDefault: s.isDefault || false,
        subscriptions: s.subscriptions || [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      });
    }
  }

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
        if (key.startsWith(agentId + ':')) {
          sessions.push({ ...data });
        }
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
      const merged = { ...existing, ...updates, lastUsedAt: Date.now() };
      sessionStore.set(key, merged);
      return merged;
    },

    createSession: (agentId, sessionId, config = {}) => {
      const key = `${agentId}:${sessionId}`;
      if (sessionStore.has(key)) throw new Error(`Session already exists: ${agentId}/${sessionId}`);
      const data = {
        id: sessionId,
        title: config.title || sessionId,
        isDefault: false,
        subscriptions: config.subscriptions || [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      sessionStore.set(key, data);
      return data;
    },
  };
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Session Subscribe / Unsubscribe ─────────────────────────────────────────

describe('session subscribeSession / unsubscribeSession', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'slack-monitor', subscriptions: [] },
        ],
      },
      { id: 'writer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('subscribeSession adds a pattern for a session', () => {
    const result = broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    assert.ok(result.success);
    assert.equal(result.pattern, 'slack/team/#general');
  });

  it('subscribeSession persists to session metadata', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const session = pm.getSession('researcher', 'slack-monitor');
    assert.ok(session.subscriptions.some(s => s.pattern === 'slack/team/#general'));
  });

  it('unsubscribeSession removes the pattern', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');
    broker.unsubscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const subs = broker.getSessionSubscriptions('researcher', 'slack-monitor');
    assert.equal(subs.length, 0);
  });

  it('getSessionSubscriptions returns session subscriptions only', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#random');

    const subs = broker.getSessionSubscriptions('researcher', 'slack-monitor');
    assert.equal(subs.length, 2);

    const patterns = subs.map(s => s.pattern);
    assert.ok(patterns.includes('slack/team/#general'));
    assert.ok(patterns.includes('slack/team/#random'));
  });

  it('throws when agentId is missing', () => {
    assert.throws(() => broker.subscribeSession(null, 'main', 'slack/**'), /agentId is required/);
  });

  it('throws when sessionId is missing', () => {
    assert.throws(() => broker.subscribeSession('researcher', null, 'slack/**'), /sessionId is required/);
  });

  it('throws when pattern is missing', () => {
    assert.throws(() => broker.subscribeSession('researcher', 'main', null), /pattern is required/);
  });
});

// ─── Session Receives Messages ──────────────────────────────────────────────

describe('session receives routed messages', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        subscriptions: [{ pattern: 'slack/**' }],
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'slack-monitor', subscriptions: [] },
        ],
      },
      { id: 'writer' },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('session subscribed to specific path receives message', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const result = broker.route('system', 'slack/team/#general', {
      command: 'new_message',
      payload: { text: 'hello' },
      source: 'slack',
    });

    assert.ok(result.delivered);
    assert.equal(result.deliveredToSessions.length, 1);
    assert.equal(result.deliveredToSessions[0].agentId, 'researcher');
    assert.equal(result.deliveredToSessions[0].sessionId, 'slack-monitor');
  });

  it('agent also receives message with handled=true when session matches', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    broker.route('system', 'slack/team/#general', {
      command: 'new_message',
      source: 'slack',
    });

    // Agent should have the message too (via its own slack/** subscription)
    const agentMsgs = broker.receive('researcher');
    assert.equal(agentMsgs.length, 1);
    assert.equal(agentMsgs[0].handled, true);
    assert.ok(Array.isArray(agentMsgs[0].handledBy));
    assert.equal(agentMsgs[0].handledBy[0].sessionId, 'slack-monitor');
  });

  it('agent receives message with handled=false when no session matches', () => {
    // No session subscriptions, only agent-level slack/**
    broker.route('system', 'slack/team/#random', {
      command: 'new_message',
      source: 'slack',
    });

    const agentMsgs = broker.receive('researcher');
    assert.equal(agentMsgs.length, 1);
    assert.equal(agentMsgs[0].handled, false);
    assert.equal(agentMsgs[0].handledBy, undefined);
  });

  it('session messages are receivable via receiveSession()', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    broker.route('system', 'slack/team/#general', {
      command: 'new_message',
      payload: { text: 'hello slack' },
      source: 'slack',
    });

    const sessionMsgs = broker.receiveSession('researcher', 'slack-monitor');
    assert.equal(sessionMsgs.length, 1);
    assert.equal(sessionMsgs[0].command, 'new_message');
    assert.equal(sessionMsgs[0].payload.text, 'hello slack');
    assert.equal(sessionMsgs[0].status, 'delivered');

    // Second receive should return empty (already delivered)
    const sessionMsgs2 = broker.receiveSession('researcher', 'slack-monitor');
    assert.equal(sessionMsgs2.length, 0);
  });
});

// ─── Multiple Sessions on Same Agent ────────────────────────────────────────

describe('multiple sessions on same agent', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        subscriptions: [{ pattern: 'slack/**' }],
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'general-monitor', subscriptions: [] },
          { id: 'random-monitor', subscriptions: [] },
        ],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('different sessions can subscribe to different patterns', () => {
    broker.subscribeSession('researcher', 'general-monitor', 'slack/team/#general');
    broker.subscribeSession('researcher', 'random-monitor', 'slack/team/#random');

    const r1 = broker.route('system', 'slack/team/#general', { command: 'msg1', source: 'slack' });
    assert.equal(r1.deliveredToSessions.length, 1);
    assert.equal(r1.deliveredToSessions[0].sessionId, 'general-monitor');

    const r2 = broker.route('system', 'slack/team/#random', { command: 'msg2', source: 'slack' });
    assert.equal(r2.deliveredToSessions.length, 1);
    assert.equal(r2.deliveredToSessions[0].sessionId, 'random-monitor');
  });

  it('both sessions match when path matches both subscriptions', () => {
    broker.subscribeSession('researcher', 'general-monitor', 'slack/team/*');
    broker.subscribeSession('researcher', 'random-monitor', 'slack/team/#random');

    const result = broker.route('system', 'slack/team/#random', { command: 'msg', source: 'slack' });

    // Both general-monitor (via wildcard) and random-monitor (via exact) should match
    assert.equal(result.deliveredToSessions.length, 2);
    const sessionIds = result.deliveredToSessions.map(s => s.sessionId);
    assert.ok(sessionIds.includes('general-monitor'));
    assert.ok(sessionIds.includes('random-monitor'));
  });

  it('agent gets handled=true with multiple handledBy entries', () => {
    broker.subscribeSession('researcher', 'general-monitor', 'slack/team/*');
    broker.subscribeSession('researcher', 'random-monitor', 'slack/team/#random');

    broker.route('system', 'slack/team/#random', { command: 'msg', source: 'slack' });

    const agentMsgs = broker.receive('researcher');
    assert.equal(agentMsgs.length, 1);
    assert.equal(agentMsgs[0].handled, true);
    assert.equal(agentMsgs[0].handledBy.length, 2);
  });
});

// ─── Session listenSession() ────────────────────────────────────────────────

describe('listenSession()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'slack-monitor', subscriptions: [] },
        ],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('fires callback when session receives a message', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const received = [];
    broker.listenSession('researcher', 'slack-monitor', (msg) => received.push(msg));

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    assert.equal(received.length, 1);
    assert.equal(received[0].command, 'hello');
  });

  it('unsubscribe function stops delivery', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const received = [];
    const unsub = broker.listenSession('researcher', 'slack-monitor', (msg) => received.push(msg));

    broker.route('system', 'slack/team/#general', { command: 'first', source: 'slack' });
    unsub();
    broker.route('system', 'slack/team/#general', { command: 'second', source: 'slack' });

    assert.equal(received.length, 1);
    assert.equal(received[0].command, 'first');
  });

  it('does not fire for messages to other sessions', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const received = [];
    broker.listenSession('researcher', 'main', (msg) => received.push(msg));

    broker.route('system', 'slack/team/#general', { command: 'hello', source: 'slack' });

    assert.equal(received.length, 0);
  });
});

// ─── Session History ────────────────────────────────────────────────────────

describe('sessionHistory()', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'slack-monitor', subscriptions: [] },
        ],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('returns message history for a session', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    broker.route('system', 'slack/team/#general', { command: 'msg1', source: 'slack' });
    broker.route('system', 'slack/team/#general', { command: 'msg2', source: 'slack' });

    const msgs = broker.sessionHistory('researcher', 'slack-monitor');
    assert.equal(msgs.length, 2);
  });

  it('returns empty array for session with no messages', () => {
    const msgs = broker.sessionHistory('researcher', 'slack-monitor');
    assert.equal(msgs.length, 0);
  });

  it('respects limit option', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    for (let i = 0; i < 5; i++) {
      broker.route('system', 'slack/team/#general', { command: `msg${i}`, source: 'slack' });
    }

    const msgs = broker.sessionHistory('researcher', 'slack-monitor', { limit: 2 });
    assert.equal(msgs.length, 2);
  });
});

// ─── Cascade: Session + Agent Both Receive ──────────────────────────────────

describe('cascade delivery', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        subscriptions: [{ pattern: 'slack/**' }],
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'slack-monitor', subscriptions: [] },
        ],
      },
      {
        id: 'writer',
        subscriptions: [{ pattern: 'slack/team/#general' }],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('session match cascades to parent agent', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const result = broker.route('system', 'slack/team/#general', {
      command: 'new_message',
      source: 'slack',
    });

    // Session matched
    assert.equal(result.deliveredToSessions.length, 1);
    assert.equal(result.deliveredToSessions[0].sessionId, 'slack-monitor');

    // Agent also matched (via agent-level slack/**)
    assert.ok(result.deliveredTo.includes('researcher'));

    // Writer also matched (via agent-level slack/team/#general) — no session, so no handled flag
    assert.ok(result.deliveredTo.includes('writer'));
  });

  it('writer agent gets handled=false (no session matched for writer)', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    broker.route('system', 'slack/team/#general', {
      command: 'new_message',
      source: 'slack',
    });

    const writerMsgs = broker.receive('writer');
    assert.equal(writerMsgs.length, 1);
    assert.equal(writerMsgs[0].handled, false);
  });

  it('route result includes deliveredToSessions array', () => {
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    const result = broker.route('system', 'slack/team/#general', {
      command: 'new_message',
      source: 'slack',
    });

    assert.ok(Array.isArray(result.deliveredToSessions));
    assert.equal(result.deliveredToSessions.length, 1);
    assert.equal(result.deliveredToSessions[0].agentId, 'researcher');
    assert.equal(result.deliveredToSessions[0].sessionId, 'slack-monitor');
  });

  it('no sessions match → agent gets handled=false, deliveredToSessions is empty', () => {
    const result = broker.route('system', 'slack/team/#random', {
      command: 'new_message',
      source: 'slack',
    });

    assert.ok(result.delivered);
    assert.equal(result.deliveredToSessions.length, 0);

    const agentMsgs = broker.receive('researcher');
    assert.equal(agentMsgs[0].handled, false);
  });
});

// ─── rebuildIndex with session subscriptions ────────────────────────────────

describe('rebuildIndex() loads session subscriptions', () => {
  let root, broker, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          {
            id: 'slack-monitor',
            subscriptions: [{ pattern: 'slack/team/#general' }],
          },
        ],
      },
    ]);
    broker = createMessageBroker(root, pm, silentLog);
  });

  afterEach(() => rmrf(root));

  it('session subscriptions from config are indexed on startup', () => {
    const result = broker.route('system', 'slack/team/#general', {
      command: 'test',
      source: 'slack',
    });

    assert.ok(result.delivered);
    assert.equal(result.deliveredToSessions.length, 1);
    assert.equal(result.deliveredToSessions[0].sessionId, 'slack-monitor');
  });

  it('rebuildIndex picks up new session subscriptions', () => {
    // Add a subscription to main session via mock
    pm.updateSession('researcher', 'main', {
      subscriptions: [{ pattern: 'email/**' }],
    });

    broker.rebuildIndex();

    const result = broker.route('system', 'email/to@test.com/from@test.com', {
      command: 'incoming',
      source: 'email',
    });

    assert.ok(result.delivered);
    assert.equal(result.deliveredToSessions.length, 1);
    assert.equal(result.deliveredToSessions[0].sessionId, 'main');
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('session message persistence', () => {
  let root, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = mockProjectManager([
      {
        id: 'researcher',
        sessions: [
          { id: 'main', isDefault: true, subscriptions: [] },
          { id: 'slack-monitor', subscriptions: [] },
        ],
      },
    ]);
  });

  afterEach(() => rmrf(root));

  it('session messages persist as JSONL in .messages/', () => {
    const broker = createMessageBroker(root, pm, silentLog);
    broker.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');

    broker.route('system', 'slack/team/#general', { command: 'msg1', source: 'slack' });
    broker.route('system', 'slack/team/#general', { command: 'msg2', source: 'slack' });

    const filePath = path.join(root, '.messages', 'session--researcher--slack-monitor.jsonl');
    assert.ok(fs.existsSync(filePath));

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });

  it('session messages survive broker recreation', () => {
    const broker1 = createMessageBroker(root, pm, silentLog);
    broker1.subscribeSession('researcher', 'slack-monitor', 'slack/team/#general');
    broker1.route('system', 'slack/team/#general', { command: 'persistent', source: 'slack' });

    const broker2 = createMessageBroker(root, pm, silentLog);
    const msgs = broker2.sessionHistory('researcher', 'slack-monitor');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].command, 'persistent');
  });
});
