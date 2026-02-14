const express = require('express');
const config = require('../config');
const RouteLoader = require('./loader');

// Simple structured logger
const log = {
  info:  (...args) => console.log(`[INFO]  ${new Date().toISOString()}`, ...args),
  warn:  (...args) => console.warn(`[WARN]  ${new Date().toISOString()}`, ...args),
  error: (...args) => console.error(`[ERROR] ${new Date().toISOString()}`, ...args),
};

const app = express();
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// --- Route discovery ---

const loader = new RouteLoader(config.routesDir, log);

/**
 * Build (or rebuild) the dynamic router from discovered route modules.
 */
function buildRouter() {
  const router = express.Router();
  const routes = loader.scan();

  for (const route of routes) {
    router[route.method](route.path, route.handler);
    log.info(`Registered ${route.method.toUpperCase()} ${route.path} (${route.file})`);
  }

  return router;
}

let dynamicRouter = buildRouter();

// Lazy-reload: re-scan routes directory on every request so new routes are
// picked up without a restart. The scan is fast (readdir + stat), and module
// caching means unchanged files are cheap to re-require.
app.use((req, res, next) => {
  dynamicRouter = buildRouter();
  dynamicRouter(req, res, next);
});

// Route listing endpoint for diagnostics
app.get('/routes', (_req, res) => {
  res.json({ routes: loader.list() });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  log.error(`Unhandled error: ${err.stack || err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Start ---

app.listen(config.port, config.host, () => {
  log.info(`OpenClaw Custom Routes server listening on ${config.host}:${config.port}`);
  log.info(`Workspace path: ${config.workspacePath}`);
  log.info(`Routes directory: ${config.routesDir}`);
  const routes = loader.list();
  log.info(`Discovered ${routes.length} route(s): ${routes.map(r => `${r.method} ${r.path}`).join(', ') || '(none)'}`);
});

module.exports = app;
