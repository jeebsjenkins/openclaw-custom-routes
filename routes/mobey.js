const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const MOBE_DIR = path.join(os.homedir(), 'Projects', 'mobe3Full');
const MAX_CONCURRENT = 3;

let running = 0;

module.exports = {
  path: '/mobey',
  method: 'post',
  description: 'Run a prompt through Claude CLI in mobe3Full workspace',

  handler(req, res) {
    const ip = req.ip || req.connection.remoteAddress;
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

    if (!local) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { prompt } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid "prompt" in request body' });
    }

    if (running >= MAX_CONCURRENT) {
      return res.status(429).json({ error: 'Too many concurrent requests' });
    }

    running++;
    const startedAt = Date.now();

    // Clean env: strip CLAUDE*, VSCODE*, ELECTRON*, and NODE_OPTIONS
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'CLAUDECODE') continue;
      if (key === 'NODE_OPTIONS') continue;
      if (key.startsWith('CLAUDE_CODE')) continue;
      if (key.startsWith('VSCODE')) continue;
      if (key.startsWith('ELECTRON')) continue;
      env[key] = value;
    }

    const proc = spawn('claude', ['-p', prompt], {
      cwd: MOBE_DIR,
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      running--;
      const durationMs = Date.now() - startedAt;

      if (code !== 0) {
        return res.status(500).json({
          error: stderr || `exit code ${code}`,
          code,
          prompt,
          stdout: stdout.trim(),
          durationMs,
        });
      }

      res.json({
        markdown: stdout.trim(),
        prompt,
        durationMs,
      });
    });
  },
};
