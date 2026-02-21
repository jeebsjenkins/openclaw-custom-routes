const axios = require('axios');

// Forward to OpenClaw gateway hooks endpoint
const OPENCLAW_GMAIL_URL = 'http://127.0.0.1:18789/hooks/gmail';
// Internal hooks token (for auth to OpenClaw gateway)
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
      // Google's pushToken (from query string) is for verifying the request came from Google
      // We use the internal hooks.token for auth to OpenClaw
      const googlePushToken = req.query.token;
      
      log('debug', `Forwarding to OpenClaw`, { 
        url: OPENCLAW_GMAIL_URL, 
        hasGoogleToken: !!googlePushToken,
        hasHooksToken: !!OPENCLAW_HOOKS_TOKEN 
      });
      
      const response = await axios.post(
        OPENCLAW_GMAIL_URL,
        req.body,
        {
          headers: {
            'Content-Type': 'application/json',
            // Use internal hooks token for OpenClaw auth
            'Authorization': `Bearer ${OPENCLAW_HOOKS_TOKEN}`
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
