# OpenClaw Gateway Integration Patches

Instructions for integrating the custom routes server with an existing OpenClaw gateway.

## Option A: Reverse Proxy (Recommended)

Add a proxy rule in your OpenClaw gateway (nginx, Caddy, or Node reverse proxy) to
forward `/api/*` and `/health` to this server.

### nginx example

```nginx
# In your OpenClaw server block
location /api/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /health {
    proxy_pass http://127.0.0.1:3100;
}
```

### Caddy example

```caddyfile
reverse_proxy /api/* 127.0.0.1:3100
reverse_proxy /health 127.0.0.1:3100
```

## Option B: Express Middleware Mount

If OpenClaw exposes its Express app instance, you can mount this server as
sub-app middleware directly:

```js
// In your OpenClaw gateway entry point
const customRoutes = require('openclaw-custom-routes/src/server');
app.use(customRoutes);
```

This shares the same process and port — no proxy needed.

## Option C: Process Manager (pm2 / systemd)

Run the custom routes server as a separate process alongside OpenClaw:

```bash
# pm2
pm2 start src/server.js --name openclaw-custom-routes

# systemd unit (save to /etc/systemd/system/openclaw-custom-routes.service)
[Unit]
Description=OpenClaw Custom Routes
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw-custom-routes
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
Environment=PORT=3100
Environment=WORKSPACE_PATH=/opt/openclaw/workspace

[Install]
WantedBy=multi-user.target
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | Server listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `WORKSPACE_PATH` | `./workspace` | Path to OpenClaw workspace |
| `ROUTES_DIR` | `./routes` | Directory to scan for route modules |

## Adding a New Route

Create a file in `routes/` exporting the route definition:

```js
module.exports = {
  path: '/api/my-endpoint',
  method: 'GET',
  description: 'What this route does',
  handler(req, res) {
    res.json({ hello: 'world' });
  },
};
```

The server picks it up automatically on the next request — no restart needed.
