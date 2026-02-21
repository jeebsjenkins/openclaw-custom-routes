const { spawn } = require('child_process');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Run a prompt through the Claude CLI and stream events as they arrive.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.cwd]          - Working directory for Claude CLI
 * @param {string} [options.systemPrompt] - System prompt to pass to Claude
 * @param {number} [options.timeoutMs]    - Timeout in ms (default 5 min)
 * @param {function} [onEvent]            - Called with (type, data) for each stream event
 *   type is one of: 'thinking', 'text', 'result', 'event'
 * @returns {Promise<{ markdown: string, durationMs: number }>}
 */
function claudeStream(prompt, options = {}, onEvent) {
  const { cwd = os.tmpdir(), systemPrompt, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const args = ['-p', '--verbose', '--output-format', 'stream-json'];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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
                if (onEvent) onEvent('thinking', { text: block.thinking });
              } else if (block.type === 'text' && block.text) {
                fullText += block.text;
                if (onEvent) onEvent('text', { text: block.text });
              }
            }
          } else if (evt.type === 'content_block_delta') {
            if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              if (onEvent) onEvent('thinking', { text: evt.delta.thinking });
            } else if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              fullText += evt.delta.text;
              if (onEvent) onEvent('text', { text: evt.delta.text });
            }
          } else if (evt.type === 'result') {
            if (evt.result && !fullText) {
              fullText = evt.result;
            }
            if (onEvent) onEvent('result', { text: fullText });
          } else {
            if (onEvent) onEvent('event', evt);
          }
        } catch {
          fullText += line;
          if (onEvent) onEvent('text', { text: line });
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (signal) {
        reject(Object.assign(new Error('Claude CLI was killed'), { signal, durationMs }));
      } else if (code !== 0) {
        reject(Object.assign(new Error(stderr || `exit code ${code}`), { code, durationMs }));
      } else {
        resolve({ markdown: fullText.trim(), durationMs });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a prompt through the Claude CLI and return the final result.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.cwd]          - Working directory for Claude CLI
 * @param {string} [options.systemPrompt] - System prompt to pass to Claude
 * @param {number} [options.timeoutMs]    - Timeout in ms (default 5 min)
 * @returns {Promise<{ markdown: string, durationMs: number }>}
 */
function claudeQuery(prompt, options = {}) {
  const { cwd = os.tmpdir(), systemPrompt, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const args = ['-p', '--verbose', '--output-format', 'json'];
  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv(),
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (signal) {
        return reject(Object.assign(new Error('Claude CLI was killed'), { signal, durationMs }));
      }
      if (code !== 0) {
        return reject(Object.assign(new Error(stderr || `exit code ${code}`), { code, durationMs }));
      }

      try {
        const wrapper = JSON.parse(stdout);
        const text = wrapper.result || wrapper.text || stdout;
        const markdown = typeof text === 'string' ? text : JSON.stringify(text);
        resolve({ markdown: markdown.trim(), durationMs });
      } catch (e) {
        reject(new Error(`Failed to parse Claude output: ${e.message}\nRaw: ${stdout.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { claudeQuery, claudeStream, cleanEnv };
