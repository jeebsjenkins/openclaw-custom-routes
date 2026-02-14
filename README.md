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
