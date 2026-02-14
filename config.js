const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3100,
  host: process.env.HOST || '0.0.0.0',
  workspacePath: process.env.WORKSPACE_PATH || path.join(__dirname, 'workspace'),
  routesDir: process.env.ROUTES_DIR || path.join(__dirname, 'routes'),
  routeScanIntervalMs: parseInt(process.env.ROUTE_SCAN_INTERVAL_MS, 10) || 5000,
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
