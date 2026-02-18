const slack = require('../src/slack');

/**
 * Example route demonstrating async processing with Slack status updates.
 * 
 * Expected POST body:
 * {
 *   "task": "Process data",
 *   "slackContext": {
 *     "token": "xoxb-...",
 *     "channel": "C01234567",
 *     "thread_ts": "1234567890.123456",  // optional
 *     "user": "U01234567"                 // optional
 *   }
 * }
 * 
 * This route:
 * 1. Immediately acknowledges receipt (HTTP 202)
 * 2. Starts async work
 * 3. Posts status updates back to Slack using the provided context
 */

module.exports = {
  path: '/api/example/slack-async',
  method: 'POST',
  description: 'Example async processing with Slack status updates',

  handler: async (req, res) => {
    const { task, slackContext } = req.body;

    // Validate required fields
    if (!task) {
      return res.status(400).json({ error: 'task is required' });
    }
    if (!slackContext || !slackContext.token || !slackContext.channel) {
      return res.status(400).json({ 
        error: 'slackContext with token and channel is required' 
      });
    }

    // Immediately acknowledge - we'll process async
    res.status(202).json({ 
      message: 'Processing started',
      task,
    });

    // Start async processing (no await - fire and forget)
    processAsync(task, slackContext).catch(err => {
      console.error('[ERROR] Async processing failed:', err);
    });
  },
};

/**
 * Async processing with Slack updates
 */
async function processAsync(task, slackContext) {
  const { token, channel, thread_ts } = slackContext;

  try {
    // Post initial status
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: `🚀 Started processing: *${task}*`,
    });

    // Simulate work
    await sleep(2000);
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: `⏳ Processing... (50%)`,
    });

    await sleep(2000);

    // Final success message
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: `✅ Completed: *${task}*`,
    });

  } catch (error) {
    // Post error back to Slack
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: `❌ Failed to process *${task}*: ${error.message}`,
    }).catch(err => {
      console.error('[ERROR] Failed to post error to Slack:', err);
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
