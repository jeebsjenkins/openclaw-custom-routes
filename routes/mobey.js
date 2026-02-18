const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const slack = require('../src/slack');

const MOBE_DIR = path.join(os.homedir(), 'Projects', 'mobe3Full');
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 3;
const STREAM_UPDATES = false; // flip to true to re-enable SSE streaming

let running = 0;

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE') continue;
    if (key === 'NODE_OPTIONS') continue;
    if (key.startsWith('CLAUDE_CODE')) continue;
    if (key.startsWith('VSCODE')) continue;
    if (key.startsWith('ELECTRON')) continue;
    env[key] = value;
  }
  return env;
}

module.exports = {
  path: '/mobey',
  method: 'post',
  description: 'Run a prompt through Claude CLI in mobe3Full workspace (SSE streaming)',

  handler(req, res) {
    const ip = req.ip || req.connection.remoteAddress;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

    if (!local) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { prompt, timeout, slackContext } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "prompt" in request body' });
    }

    if (running >= MAX_CONCURRENT) {
      return res.status(429).json({ error: 'Too many concurrent requests' });
    }

    // Optional Slack status updates
    const hasSlack = slackContext?.token && slackContext?.channel;
    const slackOpts = hasSlack ? {
      token: slackContext.token,
      channel: slackContext.channel,
      thread_ts: slackContext.thread_ts,
    } : null;

    running++;
    const startedAt = Date.now();
    const timeoutMs = Math.min(timeout || TIMEOUT_MS, TIMEOUT_MS);

    // Post initial status to Slack
    if (slackOpts) {
      slack.postMessage({
        ...slackOpts,
        text: '🔍 Querying mobe3 codebase... (this may take up to 5 minutes)',
      }).catch(err => console.error('[mobey] Failed to post start status:', err.message));
    }

    function send(event, data) {
      if (!STREAM_UPDATES) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    if (STREAM_UPDATES) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      send('start', { prompt });
    }

    const proc = spawn('claude', ['-p', '--verbose', '--output-format', 'stream-json', prompt], {
      cwd: MOBE_DIR,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: cleanEnv(),
    });

    let fullText = '';
    let stderr = '';
    let lineBuf = '';

    proc.stdout.on('data', (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);

          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'thinking' && block.thinking) {
                send('thinking', { text: block.thinking });
              } else if (block.type === 'text' && block.text) {
                fullText += block.text;
                send('text', { text: block.text });
              }
            }
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              send('thinking', { text: evt.delta.thinking });
            } else if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              fullText += evt.delta.text;
              send('text', { text: evt.delta.text });
            }
          } else if (evt.type === 'result') {
            // final result — fullText already built from deltas
            if (evt.result && !fullText) {
              fullText = evt.result;
            }
          } else {
            // tool_use, system, etc.
            send('event', evt);
          }
        } catch {
          // non-JSON line
          fullText += line;
          send('text', { text: line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(async () => {
      proc.kill('SIGTERM');
      send('error', { error: 'Claude CLI timed out', timeoutMs });

      if (slackOpts) {
        await slack.postMessage({
          ...slackOpts,
          text: `⏱️ Query timed out after ${timeoutMs / 1000}s`,
        }).catch(err => console.error('[mobey] Failed to post timeout:', err.message));
      }

      if (!STREAM_UPDATES) return res.status(504).json({ error: 'Claude CLI timed out', timeoutMs });
      res.end();
    }, timeoutMs);

    proc.on('close', async (code, signal) => {
      clearTimeout(timer);
      running--;
      const durationMs = Date.now() - startedAt;
      const durationSec = (durationMs / 1000).toFixed(1);

      if (signal) {
        send('error', { error: 'Claude CLI was killed', signal, durationMs });
        
        if (slackOpts) {
          await slack.postMessage({
            ...slackOpts,
            text: `❌ Query was killed (signal: ${signal}) after ${durationSec}s`,
          }).catch(err => console.error('[mobey] Failed to post error:', err.message));
        }

        if (!STREAM_UPDATES) return res.status(504).json({ error: 'Claude CLI was killed', signal, durationMs });
      } else if (code !== 0) {
        send('error', { error: stderr || `exit code ${code}`, code, durationMs });

        if (slackOpts) {
          await slack.postMessage({
            ...slackOpts,
            text: `❌ Query failed (exit code ${code}) after ${durationSec}s\n\`\`\`\n${stderr || '(no error output)'}\`\`\``,
          }).catch(err => console.error('[mobey] Failed to post error:', err.message));
        }

        if (!STREAM_UPDATES) return res.status(502).json({ error: stderr || `exit code ${code}`, code, durationMs });
      } else {
        send('done', { markdown: fullText.trim(), prompt, durationMs });

        if (slackOpts) {
          const result = fullText.trim();
          // If result is too long, truncate with link to full output
          const maxLen = 3000;
          const displayText = result.length > maxLen 
            ? result.substring(0, maxLen) + '\n\n_(truncated - result too long)_'
            : result;

          await slack.postMessage({
            ...slackOpts,
            text: `✅ Query complete (${durationSec}s)\n\n${displayText}`,
          }).catch(err => console.error('[mobey] Failed to post result:', err.message));
        }

        if (!STREAM_UPDATES) return res.json({ markdown: fullText.trim(), prompt, durationMs });
      }

      res.end();
    });

    // Clean up if client disconnects
    res.on('close', () => {
      if (!proc.killed) {
        proc.kill('SIGTERM');
        clearTimeout(timer);
        running--;
      }
    });
  },
};
