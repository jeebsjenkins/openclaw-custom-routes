const axios = require('axios');

const WEBHOOK_SECRET = '66d03b8c894f5f5acaaf4bd799ddb944a1ae8356b65c5cc20223b6ac1c855108';
const OPENCLAW_WEBHOOK_URL = 'http://127.0.0.1:8787/telegram-webhook';

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Telegram Webhook] [${level.toUpperCase()}]`;
  if (Object.keys(data).length > 0) {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = {
  path: '/telegram-webhook',
  method: 'POST',
  description: 'Receive Telegram webhooks and forward to OpenClaw gateway',
  handler: async (req, res) => {
    const startTime = Date.now();
    const updateId = req.body?.update_id || 'unknown';
    
    log('info', `Incoming webhook request`, {
      updateId,
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
      userAgent: req.headers['user-agent'],
      hasSecret: !!req.headers['x-telegram-bot-api-secret-token'],
      contentLength: req.headers['content-length']
    });

    try {
      // Verify Telegram secret token
      const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
      
      if (receivedSecret !== WEBHOOK_SECRET) {
        log('warn', `Unauthorized: Invalid or missing secret token`, {
          updateId,
          receivedSecretLength: receivedSecret?.length || 0,
          expectedSecretLength: WEBHOOK_SECRET.length
        });
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Log message details
      const message = req.body?.message;
      const callbackQuery = req.body?.callback_query;
      if (message) {
        log('info', `Message received`, {
          updateId,
          messageId: message.message_id,
          chatId: message.chat?.id,
          chatType: message.chat?.type,
          fromId: message.from?.id,
          fromUsername: message.from?.username,
          text: message.text?.substring(0, 100) + (message.text?.length > 100 ? '...' : ''),
          hasPhoto: !!message.photo,
          hasDocument: !!message.document
        });
      } else if (callbackQuery) {
        log('info', `Callback query received`, {
          updateId,
          callbackId: callbackQuery.id,
          fromId: callbackQuery.from?.id,
          data: callbackQuery.data
        });
      } else {
        log('info', `Other update type received`, {
          updateId,
          keys: Object.keys(req.body)
        });
      }

      // Forward to OpenClaw's Telegram webhook listener
      log('debug', `Forwarding to OpenClaw`, { url: OPENCLAW_WEBHOOK_URL });
      
      const response = await axios.post(
        OPENCLAW_WEBHOOK_URL,
        req.body,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET
          },
          timeout: 10000,
          validateStatus: () => true // Don't throw on non-2xx
        }
      );

      const duration = Date.now() - startTime;
      
      if (response.status >= 200 && response.status < 300) {
        log('info', `Successfully forwarded to OpenClaw`, {
          updateId,
          duration: `${duration}ms`,
          status: response.status
        });
      } else {
        log('error', `OpenClaw returned non-success status`, {
          updateId,
          duration: `${duration}ms`,
          status: response.status,
          statusText: response.statusText,
          responseData: typeof response.data === 'string' ? response.data.substring(0, 200) : response.data
        });
      }
      
      res.status(200).json({ ok: true });
    } catch (error) {
      const duration = Date.now() - startTime;
      log('error', `Error forwarding to OpenClaw`, {
        updateId,
        duration: `${duration}ms`,
        error: error.message,
        code: error.code,
        isAxiosError: error.isAxiosError,
        responseStatus: error.response?.status,
        responseData: error.response?.data
      });
      
      // Always return 200 to Telegram to prevent retries
      res.status(200).json({ ok: true });
    }
  }
};
