const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3100,
  host: process.env.HOST || '0.0.0.0',
  workspacePath: process.env.WORKSPACE_PATH || path.join(__dirname, 'workspace'),
  routesDir: process.env.ROUTES_DIR || path.join(__dirname, 'routes'),
  routeScanIntervalMs: parseInt(process.env.ROUTE_SCAN_INTERVAL_MS, 10) || 5000,
  logLevel: process.env.LOG_LEVEL || 'info',
  workspacePath: process.env.WORKSPACE_PATH || '/Users/nbrown/.openclaw/workspace',
  openclawGateway: process.env.OPENCLAW_GATEWAY,
  openclawGatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN,
  mobeySlackBotToken: process.env.MOBEY_SLACK_BOT_TOKEN,
  fastmailUser: process.env.FASTMAIL_USER,
  fastmailAppPassword: process.env.FASTMAIL_APP_PASSWORD,
  claudeSocketPort: parseInt(process.env.CLAUDE_SOCKET_PORT, 10) || 3101,
  claudeSocketToken: process.env.CLAUDE_SOCKET_TOKEN,
  projectRoot: process.env.PROJECT_ROOT || path.join(require('os').homedir(), '.claude-projects'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};

module.exports = config;
