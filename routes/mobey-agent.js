const axios = require('axios');

/**
 * Wrapper endpoint for mobe3-technical agent to call mobey with auto-injected Slack context.
 * 
 * The agent just POSTs: { prompt: "question" }
 * This route adds Slack context automatically and forwards to /mobey.
 * 
 * Expected POST body:
 * {
 *   "prompt": "Your mobe3 codebase question",
 *   "timeout": 300000,  // optional, max 5min
 *   "thread_ts": "1234567890.123"  // optional, for threading
 * }
 */

// Slack credentials for mobey account (from openclaw.json)
const SLACK_TOKEN = process.env.MOBEY_SLACK_TOKEN || 'REDACTED_TOKEN';
const SLACK_CHANNEL = 'C0AF2HY0D5M'; // #mobey channel

module.exports = {
  path: '/api/mobey-agent',
  method: 'POST',
  description: 'Agent-friendly mobey endpoint with auto-injected Slack context',

  handler: async (req, res) => {
    const ip = req.ip || req.connection.remoteAddress;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

    if (!local) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { prompt, timeout, thread_ts } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "prompt"' });
    }

    try {
      // Forward to /mobey with Slack context injected
      const response = await axios.post('http://127.0.0.1:3100/mobey', {
        prompt,
        timeout: timeout || 300000,
        slackContext: {
          token: SLACK_TOKEN,
          channel: SLACK_CHANNEL,
          thread_ts: thread_ts || undefined,  // optional threading
        },
      }, {
        timeout: (timeout || 300000) + 5000,  // slightly longer than mobey timeout
      });

      return res.json(response.data);

    } catch (error) {
      console.error('[mobey-agent] Error calling /mobey:', error.message);
      
      if (error.response) {
        // Forward mobey error response
        return res.status(error.response.status).json(error.response.data);
      }
      
      return res.status(500).json({ 
        error: 'Failed to call mobey endpoint',
        details: error.message,
      });
    }
  },
};
