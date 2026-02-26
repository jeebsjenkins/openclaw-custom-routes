const { execFile } = require('child_process');

module.exports = {
  path: '/tailscale',
  method: 'GET',
  description: 'Get Tailscale status',

  handler(_req, res) {
    execFile('tailscale', ['status', '--json'], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        return res.status(502).json({ error: 'Failed to get Tailscale status', detail: err.message });
      }
      try {
        const status = JSON.parse(stdout);
        res.json(status);
      } catch (e) {
        res.status(502).json({ error: 'Failed to parse Tailscale output', detail: e.message });
      }
    });
  },
};
