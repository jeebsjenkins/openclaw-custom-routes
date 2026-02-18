# OpenClaw Custom Routes

Dynamic route auto-discovery system for the OpenClaw gateway. Drop a route module into `routes/` and it's live immediately — no restart required.

## Quick Start

```bash
npm install
npm start
```

The server starts on port **3100** by default. Verify with:

```bash
curl http://localhost:3100/health
```

## How It Works

1. **Route Discovery** — On each incoming request the server scans `routes/` for `.js` files.
2. **Module Contract** — Each file exports `{ path, method, handler, description }`.
3. **Hot Loading** — New, changed, or removed route files take effect immediately without a restart.
4. **Diagnostics** — `GET /routes` returns a list of all currently registered routes.

## Project Structure

```
├── config.js            # Configuration (env vars + defaults)
├── src/
│   ├── server.js        # Express server with route discovery
│   └── loader.js        # Route auto-discovery/loading logic
├── routes/
│   ├── health.js        # GET /health
│   └── tasks.js         # GET /api/tasks/:agentId
├── workspace/           # Default workspace root
│   └── tasks/
│       └── {agentId}/   # Markdown task files per agent
├── PATCHES.md           # OpenClaw gateway integration guide
└── README.md
```

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | Server listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORKSPACE_PATH` | `./workspace` | Path to workspace directory |
| `ROUTES_DIR` | `./routes` | Directory to scan for route modules |

## Built-in Routes

### `GET /health`

Returns server health status.

```json
{ "status": "ok", "uptime": 42.5, "timestamp": "2026-02-14T..." }
```

### `GET /api/tasks/:agentId`

Lists tasks for an agent by reading markdown files from `workspace/tasks/{agentId}/`. Each file is parsed for YAML frontmatter (via `gray-matter`).

```json
{
  "agentId": "agent-1",
  "count": 2,
  "tasks": [
    {
      "file": "task-001.md",
      "title": "Implement login",
      "status": "in-progress",
      "priority": "high",
      "content": "Task body text..."
    }
  ]
}
```

### `GET /routes`

Lists all discovered routes (for diagnostics).

## Slack Integration

Custom routes can receive Slack context from OpenClaw handlers and post status updates back to Slack independently. This enables async processing with live status updates.

See **[SLACK.md](./SLACK.md)** for complete documentation on:
- Passing Slack context from handlers to custom routes
- Using the `src/slack.js` utility to post messages back
- Complete working example in `routes/example-slack-async.js`

**Quick example:**
```javascript
const slack = require('../src/slack');

await slack.postMessage({
  token: slackContext.token,
  channel: slackContext.channel,
  thread_ts: slackContext.thread_ts,
  text: '✅ Processing complete!'
});
```

## Mobey Integration (mobe3 Codebase Assistant)

### `POST /mobey`
Runs Claude CLI in the mobe3Full workspace to query the codebase. Optionally accepts Slack context for status updates.

**Request:**
```json
{
  "prompt": "What does the InventoryUI do?",
  "timeout": 300000,
  "slackContext": {
    "token": "xoxb-...",
    "channel": "C0AF2HY0D5M",
    "thread_ts": "1234567890.123"
  }
}
```

**Slack status updates (if context provided):**
- 🔍 "Querying codebase..." (on start)
- ✅ Results + duration (on success)
- ❌ Error message (on failure/timeout)

### `POST /api/mobey-agent`
Agent-friendly wrapper that auto-injects Slack context. Designed for OpenClaw agents to call without managing tokens.

**Request:**
```json
{
  "prompt": "List all stored procedures",
  "thread_ts": "1234567890.123"
}
```

Automatically adds Slack context for the `mobey` account (#mobey channel) and posts status updates.

**Configuration:**
Set `MOBEY_SLACK_TOKEN` in `.env` to override the default token (otherwise uses hardcoded value from `openclaw.json`).

## Writing a Custom Route

Create a `.js` file in `routes/`:

```js
// routes/hello.js
module.exports = {
  path: '/api/hello',
  method: 'GET',
  description: 'Greeting endpoint',
  handler(req, res) {
    res.json({ message: 'Hello from OpenClaw!' });
  },
};
```

It will be available on the next request — no server restart needed.

## Integration with OpenClaw

See [PATCHES.md](./PATCHES.md) for detailed instructions on connecting this server to an OpenClaw gateway via reverse proxy, middleware mount, or process manager.

## Development

```bash
# Run with auto-restart on source changes (Node 18+)
npm run dev
```

## License

ISC
