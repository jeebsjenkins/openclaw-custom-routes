const gateway = require('../../src/gateway');

module.exports = {
  path: '/health',
  method: 'GET',
  description: 'API health check — validates gateway connection',

  handler(_req, res) {
    const gatewayStatus = gateway.healthCheck();

    const status = gatewayStatus.connected ? 'ok' : 'degraded';
    const statusCode = gatewayStatus.connected ? 200 : 503;

    res.status(statusCode).json({
      status,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      gateway: gatewayStatus,
    });
  },
};
