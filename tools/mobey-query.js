/**
 * mobey-query — Call the /mobey endpoint (via /api/mobey-agent) with Slack context.
 *
 * Wraps the mobey-agent HTTP endpoint so agents can trigger a full mobey
 * analysis run that posts results back to Slack with formatting, file
 * uploads, and status updates.
 */

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MOBEY_AGENT_URL = 'http://127.0.0.1:3100/api/mobey-agent';

module.exports = {
  name: 'mobey-query',
  description: 'Run a prompt through the mobey endpoint, which analyzes the mobe3 codebase and posts results to Slack with formatting and status updates.',
  schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The question or task for mobe3 codebase analysis',
      },
      channel: {
        type: 'string',
        description: 'Slack channel ID (e.g. C0AF2HY0D5M) to post results to. Defaults to #mobey.',
      },
      thread_ts: {
        type: 'string',
        description: 'Thread timestamp to reply in. Required for threaded conversations.',
      },
      sender_name: {
        type: 'string',
        description: 'Display name of the person who asked the question.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default 300000 / 5 min)',
      },
    },
    required: ['prompt'],
  },

  async execute(input, context) {
    const { prompt, channel, thread_ts, sender_name, timeout } = input;
    const { log } = context;

    if (!prompt || typeof prompt !== 'string') {
      return { output: 'Missing or invalid prompt', isError: true };
    }

    const timeoutMs = timeout || DEFAULT_TIMEOUT_MS;

    try {
      const response = await axios.post(MOBEY_AGENT_URL, {
        prompt,
        timeout: timeoutMs,
        channel: channel || undefined,
        thread_ts: thread_ts || undefined,
        sender_name: sender_name || undefined,
      }, {
        timeout: timeoutMs + 10000,
      });

      return {
        output: JSON.stringify(response.data, null, 2),
        isError: false,
      };
    } catch (err) {
      const detail = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      if (log) log.error(`[mobey-query] Error: ${detail}`);
      return { output: `Failed to call mobey: ${detail}`, isError: true };
    }
  },
};
