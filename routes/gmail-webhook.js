const axios = require('axios');

// OpenClaw Gmail hook server runs on port 8788
const OPENCLAW_GMAIL_URL = 'http://127.0.0.1:8788/';

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
  description: 'Receive Gmail Pub/Sub webhooks and forward to OpenClaw gateway',
  handler: async (req, res) => {
    const startTime = Date.now();
    
    // Google Pub/Sub sends base64-encoded message in req.body.message.data
    const messageId = req.body?.message?.messageId || 'unknown';
    const subscription = req.body?.subscription || 'unknown';
    
    log('info', `Incoming Gmail Pub/Sub notification`, {
      messageId,
      subscription,
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
      contentLength: req.headers['content-length']
    });

    try {
      // Decode the Pub/Sub message if present
      if (req.body?.message?.data) {
        try {
          const decoded = Buffer.from(req.body.message.data, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          log('info', `Pub/Sub message decoded`, {
            messageId,
            emailAddress: parsed.emailAddress,
            historyId: parsed.historyId
          });
        } catch (decodeErr) {
          log('warn', `Could not decode Pub/Sub message`, {
            messageId,
            error: decodeErr.message
          });
        }
      }

      // Forward to OpenClaw's Gmail webhook listener
      log('debug', `Forwarding to OpenClaw`, { url: OPENCLAW_GMAIL_URL });
      
      const response = await axios.post(
        OPENCLAW_GMAIL_URL,
        req.body,
        {
          headers: {
            'Content-Type': 'application/json',
            // Forward any auth headers
            ...(req.headers['authorization'] && { 'Authorization': req.headers['authorization'] })
          },
          timeout: 10000,
          validateStatus: () => true // Don't throw on non-2xx
        }
      );

      const duration = Date.now() - startTime;
      
      if (response.status >= 200 && response.status < 300) {
        log('info', `Successfully forwarded to OpenClaw`, {
          messageId,
          duration: `${duration}ms`,
          status: response.status
        });
      } else {
        log('error', `OpenClaw returned non-success status`, {
          messageId,
          duration: `${duration}ms`,
          status: response.status,
          statusText: response.statusText,
          responseData: typeof response.data === 'string' ? response.data.substring(0, 200) : response.data
        });
      }
      
      // Always return 200 to Google Pub/Sub to acknowledge receipt
      res.status(200).json({ ok: true });
    } catch (error) {
      const duration = Date.now() - startTime;
      log('error', `Error forwarding to OpenClaw`, {
        messageId,
        duration: `${duration}ms`,
        error: error.message,
        code: error.code,
        isAxiosError: error.isAxiosError,
        responseStatus: error.response?.status,
        responseData: error.response?.data
      });
      
      // Return 200 to prevent Pub/Sub retries (OpenClaw will handle via polling if needed)
      res.status(200).json({ ok: true });
    }
  }
};
