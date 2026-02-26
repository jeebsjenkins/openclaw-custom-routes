/**
 * anthropicHelper.js — Lightweight Anthropic Messages API client.
 *
 * Provides a thin wrapper around the Anthropic HTTP API for quick,
 * low-latency calls (e.g. triage decisions with Haiku). Uses axios
 * (already a project dependency) — no SDK needed.
 *
 * Usage:
 *   const { createAnthropicClient } = require('./anthropicHelper');
 *   const client = createAnthropicClient({ apiKey: '...', log });
 *   const reply = await client.message({
 *     model: 'claude-haiku-4-5-20241022',
 *     maxTokens: 256,
 *     messages: [{ role: 'user', content: 'Say hello' }],
 *   });
 *   console.log(reply.text); // "Hello!"
 */

const axios = require('axios');

const ANTHROPIC_API_URL = 'https://messages.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30000;

// Model aliases → full model strings
const MODEL_ALIASES = {
  haiku: 'claude-haiku-4-5-20241022',
  sonnet: 'claude-sonnet-4-5-20250514',
  opus: 'claude-opus-4-0-20250115',
};

/**
 * Resolve a model alias to its full model string.
 * Passes through already-qualified model names unchanged.
 */
function resolveModel(model) {
  return MODEL_ALIASES[model] || model;
}

/**
 * Create an Anthropic API client.
 *
 * @param {object} opts
 * @param {string}  opts.apiKey     - Anthropic API key (required)
 * @param {number}  [opts.timeoutMs] - Request timeout (default 30s)
 * @param {object}  [opts.log]      - Logger
 * @returns {{ message, resolveModel }}
 */
function createAnthropicClient(opts = {}) {
  const {
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log = console,
  } = opts;

  if (!apiKey) {
    throw new Error('anthropicHelper: apiKey is required (set ANTHROPIC_API_KEY)');
  }

  /**
   * Send a Messages API request.
   *
   * @param {object} params
   * @param {string}   params.model       - Model name or alias ('haiku', 'sonnet', etc.)
   * @param {number}   [params.maxTokens] - Max tokens to generate (default 256)
   * @param {Array}    params.messages     - Messages array [{ role, content }]
   * @param {string}   [params.system]     - System prompt
   * @param {number}   [params.temperature] - Temperature (0-1)
   * @param {number}   [params.timeoutMs]  - Per-request timeout override
   * @returns {Promise<{ text: string, model: string, usage: object, stopReason: string }>}
   */
  async function message(params) {
    const {
      model,
      maxTokens = 256,
      messages,
      system,
      temperature,
      timeoutMs: reqTimeout,
    } = params;

    if (!messages || messages.length === 0) {
      throw new Error('anthropicHelper.message: messages array is required');
    }

    const resolvedModel = resolveModel(model);

    const body = {
      model: resolvedModel,
      max_tokens: maxTokens,
      messages,
    };

    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;

    try {
      const response = await axios.post(ANTHROPIC_API_URL, body, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        timeout: reqTimeout || timeoutMs,
      });

      const data = response.data;

      // Extract text from content blocks
      const text = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      return {
        text,
        model: data.model,
        usage: data.usage || {},
        stopReason: data.stop_reason,
      };
    } catch (err) {
      // Unwrap axios error for cleaner messages
      if (err.response) {
        const status = err.response.status;
        const errData = err.response.data;
        const msg = errData?.error?.message || JSON.stringify(errData);
        throw new Error(`Anthropic API ${status}: ${msg}`);
      }
      if (err.code === 'ECONNABORTED') {
        throw new Error(`Anthropic API timeout after ${reqTimeout || timeoutMs}ms`);
      }
      throw err;
    }
  }

  return { message, resolveModel };
}

module.exports = { createAnthropicClient, resolveModel, MODEL_ALIASES };
