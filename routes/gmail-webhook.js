const axios = require('axios');
const { execSync } = require('child_process');

// Forward to OpenClaw hooks endpoint with fetched email content
const OPENCLAW_HOOKS_URL = 'http://127.0.0.1:18789/hooks/gmail';
const OPENCLAW_HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '4413a40184f6c46ef6134f1f42f7f19f62608dad1536b7a2';
const GMAIL_ACCOUNT = 'solomon.jenkinsai@gmail.com';

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [Gmail Webhook] [${level.toUpperCase()}]`;
  if (Object.keys(data).length > 0) {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Fetch email content using gog CLI
function fetchEmailsSinceHistory(historyId) {
  try {
    // Get messages added since historyId
    const cmd = `gog gmail history --since=${historyId} --json --account=${GMAIL_ACCOUNT} 2>/dev/null`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    const data = JSON.parse(output);
    
    // Extract message IDs from history
    const messageIds = [];
    if (data.history) {
      for (const h of data.history) {
        if (h.messagesAdded) {
          for (const m of h.messagesAdded) {
            if (m.message?.id) {
              messageIds.push(m.message.id);
            }
          }
        }
      }
    }
    
    if (messageIds.length === 0) {
      log('info', 'No new messages in history');
      return [];
    }
    
    // Fetch each message
    const messages = [];
    for (const msgId of messageIds.slice(0, 5)) { // Limit to 5 messages
      try {
        const msgCmd = `gog gmail messages get ${msgId} --json --account=${GMAIL_ACCOUNT} 2>/dev/null`;
        const msgOutput = execSync(msgCmd, { encoding: 'utf8', timeout: 15000 });
        const msg = JSON.parse(msgOutput);
        
        // Extract headers
        const headers = msg.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        
        // Extract body
        let body = '';
        if (msg.payload?.body?.data) {
          body = Buffer.from(msg.payload.body.data, 'base64').toString('utf8');
        } else if (msg.payload?.parts) {
          for (const part of msg.payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
              body = Buffer.from(part.body.data, 'base64').toString('utf8');
              break;
            }
          }
        }
        
        messages.push({
          id: msgId,
          from: getHeader('From'),
          subject: getHeader('Subject'),
          body: body.slice(0, 20000) // Limit body size
        });
      } catch (msgErr) {
        log('warn', `Failed to fetch message ${msgId}`, { error: msgErr.message });
      }
    }
    
    return messages;
  } catch (err) {
    log('error', 'Failed to fetch history', { error: err.message });
    return [];
  }
}

module.exports = {
  path: '/gmail-pubsub',
  method: 'POST',
  description: 'Receive Gmail Pub/Sub webhooks, fetch email content, forward to OpenClaw',
  handler: async (req, res) => {
    const startTime = Date.now();
    
    const pubsubMessageId = req.body?.message?.messageId || 'unknown';
    
    log('info', `Incoming Gmail Pub/Sub notification`, {
      pubsubMessageId,
      subscription: req.body?.subscription
    });

    try {
      // Decode the Pub/Sub message
      let historyId = null;
      let emailAddress = null;
      
      if (req.body?.message?.data) {
        try {
          const decoded = Buffer.from(req.body.message.data, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded);
          historyId = parsed.historyId;
          emailAddress = parsed.emailAddress;
          log('info', `Pub/Sub decoded`, { historyId, emailAddress });
        } catch (decodeErr) {
          log('warn', `Could not decode Pub/Sub message`, { error: decodeErr.message });
        }
      }
      
      if (!historyId) {
        log('warn', 'No historyId in notification, skipping');
        return res.status(200).json({ ok: true, skipped: 'no historyId' });
      }
      
      // Fetch actual email content using gog
      log('info', `Fetching emails since historyId ${historyId}`);
      const messages = fetchEmailsSinceHistory(historyId);
      
      if (messages.length === 0) {
        log('info', 'No messages to forward');
        return res.status(200).json({ ok: true, skipped: 'no messages' });
      }
      
      log('info', `Fetched ${messages.length} message(s)`, {
        subjects: messages.map(m => m.subject)
      });
      
      // Forward to OpenClaw hooks endpoint with proper format
      const response = await axios.post(
        OPENCLAW_HOOKS_URL,
        { messages },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENCLAW_HOOKS_TOKEN}`
          },
          timeout: 30000,
          validateStatus: () => true
        }
      );

      const duration = Date.now() - startTime;
      
      if (response.status >= 200 && response.status < 300) {
        log('info', `Successfully forwarded to OpenClaw`, {
          duration: `${duration}ms`,
          status: response.status,
          messageCount: messages.length
        });
      } else {
        log('error', `OpenClaw returned error`, {
          duration: `${duration}ms`,
          status: response.status,
          responseData: response.data
        });
      }
      
      res.status(200).json({ ok: true, forwarded: messages.length });
    } catch (error) {
      const duration = Date.now() - startTime;
      log('error', `Error processing webhook`, {
        duration: `${duration}ms`,
        error: error.message
      });
      
      res.status(200).json({ ok: true, error: error.message });
    }
  }
};
