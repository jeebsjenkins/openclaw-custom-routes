module.exports = {
  path: '/health',
  method: 'GET',
  description: 'Health check endpoint',

  handler(_req, res) {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  },
};
