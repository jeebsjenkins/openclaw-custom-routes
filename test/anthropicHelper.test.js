/**
 * anthropicHelper.test.js — Tests for the Anthropic API client.
 *
 * Run:  node --test test/anthropicHelper.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAnthropicClient, resolveModel, MODEL_ALIASES } = require('../src/anthropicHelper');

// ─── resolveModel ────────────────────────────────────────────────────────────

describe('resolveModel', () => {
  it('resolves "haiku" alias to full model string', () => {
    assert.equal(resolveModel('haiku'), MODEL_ALIASES.haiku);
  });

  it('resolves "sonnet" alias to full model string', () => {
    assert.equal(resolveModel('sonnet'), MODEL_ALIASES.sonnet);
  });

  it('resolves "opus" alias to full model string', () => {
    assert.equal(resolveModel('opus'), MODEL_ALIASES.opus);
  });

  it('passes through already-qualified model names', () => {
    assert.equal(resolveModel('claude-haiku-4-5-20241022'), 'claude-haiku-4-5-20241022');
    assert.equal(resolveModel('custom-model-v1'), 'custom-model-v1');
  });
});

// ─── createAnthropicClient ──────────────────────────────────────────────────

describe('createAnthropicClient', () => {
  it('throws if apiKey is missing', () => {
    assert.throws(
      () => createAnthropicClient({}),
      /apiKey is required/,
    );
  });

  it('throws if apiKey is empty string', () => {
    assert.throws(
      () => createAnthropicClient({ apiKey: '' }),
      /apiKey is required/,
    );
  });

  it('returns client with message and resolveModel methods', () => {
    const client = createAnthropicClient({ apiKey: 'sk-test-key' });
    assert.equal(typeof client.message, 'function');
    assert.equal(typeof client.resolveModel, 'function');
  });

  it('message() rejects if messages array is empty', async () => {
    const client = createAnthropicClient({ apiKey: 'sk-test-key' });
    await assert.rejects(
      () => client.message({ model: 'haiku', messages: [] }),
      /messages array is required/,
    );
  });

  it('message() rejects if messages is missing', async () => {
    const client = createAnthropicClient({ apiKey: 'sk-test-key' });
    await assert.rejects(
      () => client.message({ model: 'haiku' }),
      /messages array is required/,
    );
  });
});
