/**
 * projectManager.test.js — Tests for agent creation from template.
 *
 * Run:  node --test test/projectManager.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createProjectManager } = require('../src/projectManager');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Template Cloning ───────────────────────────────────────────────────────

describe('agent creation from template', () => {
  let root, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = createProjectManager(root);
  });

  afterEach(() => rmrf(root));

  it('creates all template directories', () => {
    pm.createAgent('researcher', { description: 'Research agent' });

    const agentPath = path.join(root, 'researcher');
    assert.ok(fs.existsSync(path.join(agentPath, '.claude')));
    assert.ok(fs.existsSync(path.join(agentPath, 'sessions')));
    assert.ok(fs.existsSync(path.join(agentPath, 'tools')));
    // No conversations/ dir — logs live in sessions/ alongside metadata
    assert.ok(!fs.existsSync(path.join(agentPath, 'conversations')));
  });

  it('interpolates {{id}} and {{name}} in jvAgent.json', () => {
    pm.createAgent('researcher', { description: 'Research agent' });

    const config = JSON.parse(
      fs.readFileSync(path.join(root, 'researcher', 'jvAgent.json'), 'utf8')
    );

    assert.equal(config.id, 'researcher');
    assert.equal(config.name, 'researcher');
    assert.equal(config.description, 'Research agent');
    assert.deepStrictEqual(config.subscriptions, []);
  });

  it('interpolates {{name}} and {{description}} in CLAUDE.md', () => {
    pm.createAgent('writer', { description: 'Writing agent' });

    const claudeMd = fs.readFileSync(path.join(root, 'writer', 'CLAUDE.md'), 'utf8');

    assert.ok(claudeMd.includes('# writer'));
    assert.ok(claudeMd.includes('Writing agent'));
    assert.ok(!claudeMd.includes('{{'));
  });

  it('creates default main session with timestamps', () => {
    const before = Date.now();
    pm.createAgent('reviewer');
    const after = Date.now();

    const session = JSON.parse(
      fs.readFileSync(path.join(root, 'reviewer', 'sessions', 'main.json'), 'utf8')
    );

    assert.equal(session.id, 'main');
    assert.equal(session.isDefault, true);
    assert.ok(session.createdAt >= before && session.createdAt <= after);
  });

  it('applies config overrides (workDirs, defaultModel, subscriptions)', () => {
    pm.createAgent('coder', {
      workDirs: ['/home/user/project'],
      defaultModel: 'claude-sonnet-4-5',
      subscriptions: [{ pattern: 'slack/**' }],
    });

    const config = JSON.parse(
      fs.readFileSync(path.join(root, 'coder', 'jvAgent.json'), 'utf8')
    );

    assert.deepStrictEqual(config.workDirs, ['/home/user/project']);
    assert.equal(config.defaultModel, 'claude-sonnet-4-5');
    assert.deepStrictEqual(config.subscriptions, [{ pattern: 'slack/**' }]);
  });

  it('applies custom claudeMd override', () => {
    pm.createAgent('specialist', {
      claudeMd: '# Custom\n\nFully custom system prompt.\n',
    });

    const claudeMd = fs.readFileSync(path.join(root, 'specialist', 'CLAUDE.md'), 'utf8');

    assert.equal(claudeMd, '# Custom\n\nFully custom system prompt.\n');
  });

  it('creates nested agents with full template', () => {
    pm.createAgent('research/deep', { description: 'Deep research sub-agent' });

    const agentPath = path.join(root, 'research', 'deep');
    assert.ok(fs.existsSync(path.join(agentPath, 'jvAgent.json')));
    assert.ok(fs.existsSync(path.join(agentPath, 'CLAUDE.md')));
    assert.ok(fs.existsSync(path.join(agentPath, 'tools')));

    const config = JSON.parse(fs.readFileSync(path.join(agentPath, 'jvAgent.json'), 'utf8'));
    assert.equal(config.id, 'research/deep');
    assert.equal(config.name, 'deep');
  });

  it('does not overwrite existing files', () => {
    // Create agent manually first
    const agentPath = path.join(root, 'existing');
    fs.mkdirSync(agentPath, { recursive: true });
    fs.writeFileSync(
      path.join(agentPath, 'CLAUDE.md'),
      '# Existing content\n\nDo not overwrite.\n'
    );

    // Now create through projectManager — should not clobber CLAUDE.md
    pm.createAgent('existing', { description: 'New description' });

    const claudeMd = fs.readFileSync(path.join(agentPath, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('Existing content'));
    assert.ok(claudeMd.includes('Do not overwrite'));
  });

  it('throws when agent already exists', () => {
    pm.createAgent('unique');
    assert.throws(() => pm.createAgent('unique'), /already exists/);
  });
});

// ─── Conversation Logs (in sessions/) ──────────────────────────────────────

describe('conversation logs consolidated in sessions/', () => {
  let root, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = createProjectManager(root);
  });

  afterEach(() => rmrf(root));

  it('appendConversationLog writes to sessions/ not conversations/', () => {
    pm.createAgent('researcher');
    pm.appendConversationLog('researcher', 'main', { role: 'user', text: 'hello' });

    // Should exist in sessions/
    const logPath = path.join(root, 'researcher', 'sessions', 'main.jsonl');
    assert.ok(fs.existsSync(logPath));

    // Should NOT exist in conversations/
    const oldPath = path.join(root, 'researcher', 'conversations', 'main.jsonl');
    assert.ok(!fs.existsSync(oldPath));
  });

  it('getConversationLog reads from sessions/', () => {
    pm.createAgent('researcher');
    pm.appendConversationLog('researcher', 'main', { role: 'user', text: 'hello' });
    pm.appendConversationLog('researcher', 'main', { role: 'assistant', text: 'hi' });

    const entries = pm.getConversationLog('researcher', 'main');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].text, 'hello');
    assert.equal(entries[1].text, 'hi');
  });
});

// ─── Session CRUD ──────────────────────────────────────────────────────────

describe('createSession / updateSession', () => {
  let root, pm;

  beforeEach(() => {
    root = tmpDir();
    pm = createProjectManager(root);
  });

  afterEach(() => rmrf(root));

  it('createSession creates a named session with subscriptions', () => {
    pm.createAgent('researcher');
    const session = pm.createSession('researcher', 'slack-monitor', {
      title: 'Slack Monitor',
      subscriptions: [{ pattern: 'slack/team/#general' }],
    });

    assert.equal(session.id, 'slack-monitor');
    assert.equal(session.title, 'Slack Monitor');
    assert.equal(session.isDefault, false);
    assert.deepStrictEqual(session.subscriptions, [{ pattern: 'slack/team/#general' }]);
    assert.ok(session.createdAt > 0);
  });

  it('createSession throws if session already exists', () => {
    pm.createAgent('researcher');
    pm.createSession('researcher', 'monitor');
    assert.throws(() => pm.createSession('researcher', 'monitor'), /already exists/);
  });

  it('updateSession merges updates', () => {
    pm.createAgent('researcher');
    pm.createSession('researcher', 'monitor', { title: 'Monitor' });

    const updated = pm.updateSession('researcher', 'monitor', {
      subscriptions: [{ pattern: 'email/**' }],
    });

    assert.equal(updated.id, 'monitor');
    assert.equal(updated.title, 'Monitor');
    assert.deepStrictEqual(updated.subscriptions, [{ pattern: 'email/**' }]);
  });

  it('updateSession throws for non-existent session', () => {
    pm.createAgent('researcher');
    assert.throws(() => pm.updateSession('researcher', 'nope', {}), /not found/);
  });

  it('listSessions includes sessions with subscriptions', () => {
    pm.createAgent('researcher');
    pm.createSession('researcher', 'slack-monitor', {
      subscriptions: [{ pattern: 'slack/**' }],
    });

    const sessions = pm.listSessions('researcher');
    const monitor = sessions.find(s => s.id === 'slack-monitor');
    assert.ok(monitor);
    assert.deepStrictEqual(monitor.subscriptions, [{ pattern: 'slack/**' }]);
  });
});

// ─── Default "main" Agent ─────────────────────────────────────────────────

describe('default main agent', () => {
  it('is created from template on projectManager init', () => {
    const root = tmpDir();
    try {
      createProjectManager(root);

      const mainPath = path.join(root, 'main');
      assert.ok(fs.existsSync(path.join(mainPath, 'jvAgent.json')));
      assert.ok(fs.existsSync(path.join(mainPath, 'CLAUDE.md')));
      assert.ok(fs.existsSync(path.join(mainPath, 'tools')));
      assert.ok(fs.existsSync(path.join(mainPath, 'sessions', 'main.json')));

      const config = JSON.parse(
        fs.readFileSync(path.join(mainPath, 'jvAgent.json'), 'utf8')
      );
      assert.equal(config.id, 'main');
    } finally {
      rmrf(root);
    }
  });
});
