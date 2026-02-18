# Slack Context Passing

This document explains how to pass Slack context from OpenClaw handlers to custom routes, enabling async processing with status updates back to Slack.

## Architecture

```
Slack message → OpenClaw handler → Custom route (POST with slackContext)
                                    ↓
                                    Async processing
                                    ↓
                                    Posts back to Slack (same thread)
```

## Pattern

### 1. In Your OpenClaw Slack Handler

When calling a custom route, include a `slackContext` object with:

```javascript
{
  "task": "Your processing task",
  "slackContext": {
    "token": "xoxb-...",           // Slack bot token (from config)
    "channel": "C01234567",        // Channel ID where message came from
    "thread_ts": "1234567890.123", // Thread timestamp (optional, for replies)
    "user": "U01234567"            // User ID who triggered (optional)
  }
}
```

**Example:**
```javascript
// In your Slack handler (OpenClaw side)
const response = await fetch('http://localhost:3100/api/process-data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    data: payload,
    slackContext: {
      token: config.slack.token,      // From OpenClaw config
      channel: event.channel,          // From Slack event
      thread_ts: event.thread_ts || event.ts,  // Thread or message ts
      user: event.user,
    }
  })
});
```

### 2. In Your Custom Route

Receive the context and use the Slack utility to post back:

```javascript
const slack = require('../src/slack');

module.exports = {
  path: '/api/process-data',
  method: 'POST',
  description: 'Process data with Slack status updates',

  handler: async (req, res) => {
    const { data, slackContext } = req.body;

    // Validate
    if (!slackContext?.token || !slackContext?.channel) {
      return res.status(400).json({ error: 'slackContext required' });
    }

    // Acknowledge immediately (202 = Accepted)
    res.status(202).json({ message: 'Processing started' });

    // Process async (fire and forget)
    processAsync(data, slackContext).catch(console.error);
  }
};

async function processAsync(data, { token, channel, thread_ts }) {
  try {
    // Initial status
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: '🚀 Processing started...'
    });

    // Do work...
    const result = await doWork(data);

    // Success
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: `✅ Done! Result: ${result}`
    });

  } catch (error) {
    await slack.postMessage({
      token,
      channel,
      thread_ts,
      text: `❌ Error: ${error.message}`
    });
  }
}
```

## Slack Utility API

The `src/slack.js` module provides:

### `postMessage(options)`
Post a new message to Slack.

```javascript
await slack.postMessage({
  token: 'xoxb-...',
  channel: 'C01234567',
  text: 'Hello from custom route!',
  thread_ts: '1234567890.123',  // optional - post in thread
  blocks: [...],                 // optional - Block Kit blocks
  attachments: [...],            // optional - legacy attachments
  mrkdwn: true,                  // optional - enable markdown (default: true)
});
```

### `updateMessage(options)`
Update an existing message.

```javascript
await slack.updateMessage({
  token: 'xoxb-...',
  channel: 'C01234567',
  ts: '1234567890.123',  // message timestamp to update
  text: 'Updated text',
  blocks: [...],          // optional
});
```

### `addReaction(options)`
Add emoji reaction to a message.

```javascript
await slack.addReaction({
  token: 'xoxb-...',
  channel: 'C01234567',
  timestamp: '1234567890.123',
  name: 'thumbsup',  // emoji name without colons
});
```

## Complete Example

See `routes/example-slack-async.js` for a full working example.

### Testing

```bash
# Start the custom routes server
npm run dev

# In another terminal, post to the route
curl -X POST http://localhost:3100/api/example/slack-async \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Test processing",
    "slackContext": {
      "token": "xoxb-YOUR-TOKEN",
      "channel": "C01234567",
      "thread_ts": "1234567890.123"
    }
  }'
```

You should see:
1. Immediate 202 response
2. Status messages appearing in the Slack thread

## Security Notes

- **Never log tokens** - they're sensitive credentials
- **Validate context** - always check token/channel are present
- **Error handling** - always catch and report errors back to Slack
- **Rate limits** - Slack has rate limits; be mindful of posting frequency

## Integration Checklist

When adding Slack context passing to a handler:

- [ ] Extract token from OpenClaw config
- [ ] Extract channel/thread_ts from Slack event
- [ ] POST to custom route with `slackContext` object
- [ ] Custom route validates context
- [ ] Custom route returns 202 immediately
- [ ] Async processing posts updates back to Slack
- [ ] Error handling posts failures to Slack
- [ ] Test with real Slack workspace

## Dependencies

The custom routes server needs `@slack/web-api`:

```bash
npm install @slack/web-api
```

Already installed in this project.
