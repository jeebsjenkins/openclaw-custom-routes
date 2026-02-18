const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const MOBE_DIR = path.join(os.homedir(), 'Projects', 'mobe3Full');
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT = 3;

// Track running CLI processes
const running = new Map(); // id -> { process, prompt, startedAt }
let nextId = 1;

function killProcess(id) {
  const entry = running.get(id);
  if (entry) {
    entry.process.kill('SIGTERM');
    running.delete(id);
  }
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

    const { prompt, timeout } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "prompt" in request body' });
    }

    if (running.size >= MAX_CONCURRENT) {
      return res.status(429).json({
        error: 'Too many concurrent requests',
        running: running.size,
        max: MAX_CONCURRENT,
      });
    }

    const id = nextId++;
    const timeoutMs = Math.min(timeout || TIMEOUT_MS, TIMEOUT_MS);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    function send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    send('start', { id, prompt });

    const env = { ...process.env };
    // Strip Claude Code session vars that trigger nested-session detection
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;
    delete env.CLAUDE_AGENT_SDK_VERSION;

    const proc = spawn('claude', ['-p', '--output-format', 'stream-json', prompt], {
      cwd: MOBE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startedAt = Date.now();
    running.set(id, { process: proc, prompt, startedAt });

    let fullText = '';
    let stderr = '';
    let lineBuf = '';

    proc.stdout.on('data', (chunk) => {
      lineBuf += chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          // relay content deltas as they arrive
          if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'text' && block.text) {
                fullText += block.text;
                send('text', { text: block.text });
              }
            }
          } else if (evt.type === 'content_block_delta' && evt.delta?.text) {
            fullText += evt.delta.text;
            send('text', { text: evt.delta.text });
          } else if (evt.type === 'result') {
            // final result message from stream-json
            if (evt.result) {
              fullText = evt.result;
              send('text', { text: evt.result });
            }
          } else {
            // forward everything else (thinking, tool use, etc.)
            send('event', evt);
          }
        } catch {
          // non-JSON line, send as raw text
          fullText += line;
          send('text', { text: line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      send('stderr', { text: chunk.toString() });
    });

    const timer = setTimeout(() => {
      killProcess(id);
      send('error', {
        error: 'Claude CLI timed out',
        id,
        prompt,
        timeoutMs,
        durationMs: Date.now() - startedAt,
      });
      res.end();
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      running.delete(id);
      const durationMs = Date.now() - startedAt;

      if (signal) {
        send('error', {
          error: 'Claude CLI was killed',
          id,
          signal,
          code,
          prompt,
          stdout: fullText.trim(),
          stderr: stderr.trim(),
          durationMs,
        });
      } else if (code !== 0) {
        send('error', {
          error: 'Claude CLI exited with non-zero status',
          id,
          code,
          prompt,
          stdout: fullText.trim(),
          stderr: stderr.trim(),
          durationMs,
        });
      } else {
        send('done', {
          markdown: fullText.trim(),
          prompt,
          durationMs,
        });
      }

      res.end();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      running.delete(id);

      send('error', {
        error: 'Failed to spawn Claude CLI',
        id,
        prompt,
        message: err.message,
        stack: err.stack,
        code: err.code,
        cwd: MOBE_DIR,
      });
      res.end();
    });

    // Clean up if client disconnects
    res.on('close', () => {
      if (running.has(id)) {
        killProcess(id);
        clearTimeout(timer);
      }
    });
  },
};
