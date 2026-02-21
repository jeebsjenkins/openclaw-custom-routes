const axios = require('axios');

// Trigger OpenClaw to check email via hooks endpoint
const OPENCLAW_HOOKS_URL = 'http://127.0.0.1:18789/hooks/gmail';
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '4413a40184f6c46ef6134f1f42f7f19f62608dad1536b7a2';

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Gmail Webhook] [${level.toUpperCase()}]`;
  if (Object.keys(data).length > 0) {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = {
  path: '/gmail-pubsub',
  method: 'POST',
  description: 'Receive Gmail Pub/Sub notification and trigger OpenClaw to check email',
  handler: async (req, res) => {
    const startTime = Date.now();
    const pubsubMessageId = req.body?.message?.messageId || 'unknown';
    
    // Decode historyId for logging
    let historyId = null;
    let emailAddress = null;
    if (req.body?.message?.data) {
      try {
        const decoded = Buffer.from(req.body.message.data, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        historyId = parsed.historyId;
        emailAddress = parsed.emailAddress;
      } catch (e) {
        // ignore decode errors
      }
    }
    
    log('info', `Gmail notification`, { pubsubMessageId, historyId, emailAddress });

    try {
      // Send trigger payload - agent will check email via gog
      const payload = {
        trigger: 'gmail_notification',
        historyId,
        emailAddress,
        timestamp: new Date().toISOString()
      };
      
      const response = await axios.post(
        OPENCLAW_HOOKS_URL,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENCLAW_HOOKS_TOKEN}`
          },
          timeout: 10000,
          validateStatus: () => true
        }
      );

      const duration = Date.now() - startTime;
      log('info', `Trigger sent`, { duration: `${duration}ms`, status: response.status });
      
      res.status(200).json({ ok: true });
    } catch (error) {
      log('error', `Failed to send trigger`, { error: error.message });
      res.status(200).json({ ok: true }); // Always ack to Pub/Sub
    }
  }
};
