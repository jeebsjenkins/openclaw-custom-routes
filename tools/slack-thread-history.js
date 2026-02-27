/**
 * slack-thread-history — Fetch full Slack thread context.
 *
 * Retrieves all messages in a Slack thread using conversations.replies.
 * Uses the Slack Web API client from the service context (not agent secrets)
 * since the bot token is a system-level credential, not per-agent.
 *
 * Usage in agent prompt:
 *   { "tool": "slack-thread-history", "input": { "channel": "C0123ABC", "threadTs": "1234567890.123456" } }
 */

module.exports = {
  name: 'slack-thread-history',
  description: 'Fetch the full message history of a Slack thread. Returns all replies in chronological order.',
  schema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Slack channel ID (e.g. C0123ABC456)',
      },
      threadTs: {
        type: 'string',
        description: 'Thread timestamp (thread_ts) of the parent message',
      },
      limit: {
        type: 'number',
        description: 'Max messages to fetch (default 50, max 200)',
        default: 50,
      },
    },
    required: ['channel', 'threadTs'],
  },

  async execute(input, context) {
    const { channel, threadTs, limit = 50 } = input;
    const { log } = context;

    // The Slack Web API client is made available via the service context.
    // It's injected by the serviceLoader when Slack service starts, and shared
    // via messageBroker metadata or a global service registry.
    let slackWeb;
    try {
      // Try to get the Slack web client from the service registry
      const { WebClient } = require('@slack/web-api');
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (!botToken) {
        return { output: 'SLACK_BOT_TOKEN not configured in environment', isError: true };
      }
      slackWeb = new WebClient(botToken);
    } catch (err) {
      return { output: `Failed to initialize Slack client: ${err.message}`, isError: true };
    }

    try {
      const clampedLimit = Math.min(Math.max(limit, 1), 200);
      const result = await slackWeb.conversations.replies({
        channel,
        ts: threadTs,
        limit: clampedLimit,
        inclusive: true,
      });

      if (!result.ok) {
        return { output: `Slack API error: ${result.error}`, isError: true };
      }

      const messages = (result.messages || []).map(m => ({
        user: m.user || m.bot_id || 'unknown',
        text: m.text || '',
        ts: m.ts,
        type: m.subtype || 'message',
      }));

      return {
        output: JSON.stringify({
          channel,
          threadTs,
          messageCount: messages.length,
          hasMore: result.has_more || false,
          messages,
        }, null, 2),
      };
    } catch (err) {
      if (log) log.error(`[slack-thread-history] Error: ${err.message}`);
      return { output: `Failed to fetch thread: ${err.message}`, isError: true };
    }
  },
};
