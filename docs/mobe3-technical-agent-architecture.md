# mobe3-technical Agent Architecture

Migration reference for redeploying the mobe3-technical agent on a new platform. Covers the OpenClaw orchestration layer and the `openclaw-custom-routes` codebase that does the heavy lifting.

---

## Architecture Overview

```
Slack (#mobey channel, Socket Mode)
  |
OpenClaw (agent binding: mobe3-technical)
  |
Agent calls POST http://127.0.0.1:3100/api/mobey-agent
  |
Custom Routes Server (Express on :3100)
  |-- /api/mobey-agent  (injects Slack context, proxies to /mobey)
  |-- /mobey            (preprocessing + Claude CLI + Slack delivery)
  |
Claude CLI spawns in ~/Projects/mobe3Full
  |
Response delivered via Slack API (@slack/web-api) or email (nodemailer/Fastmail)
  |
Agent receives HTTP response, returns NO_REPLY (Slack already handled)
```

Two processes run: OpenClaw (manages the agent lifecycle + Slack socket) and the custom routes Express server (does all the actual work). They talk over localhost HTTP.

---

## Custom Routes Server

**Repo:** `openclaw-custom-routes`
**Runtime:** Node.js / Express 5
**Port:** 3100 (configurable via `PORT` env var)
**Process manager:** pm2

### How Routes Work

The server uses auto-discovery. `src/loader.js` recursively scans the `routes/` directory for `.js` files. Each file exports `{ path, method, handler }`. Routes are re-scanned on every request (hot-reload, no restart needed). Subdirectories map to path prefixes, so `routes/api/mobey.js` with `path: '/mobey'` registers as `POST /api/mobey`.

### Gateway Connection

On startup, `src/gateway.js` opens a WebSocket to the OpenClaw gateway. It handles a challenge-response handshake using Ed25519 device signing (`src/deviceIdentity.js`, uses `@noble/ed25519`). The device identity is stored in `.device-identity.json` at the project root. This connection is what lets the custom routes server participate in the OpenClaw ecosystem.

### Key Files

| File | Purpose |
|------|---------|
| `src/server.js` | Express app, route loading, gateway connect, Claude WebSocket server init |
| `src/loader.js` | Route auto-discovery from `routes/` directory |
| `src/gateway.js` | WebSocket connection to OpenClaw gateway with device auth |
| `src/deviceIdentity.js` | Ed25519 keypair generation/storage for gateway auth |
| `src/claudeHelper.js` | Spawns `claude` CLI, streams JSON events, returns markdown |
| `src/claudeSocket.js` | WebSocket server for remote Claude CLI access (mobile/Tailscale) |
| `src/slackHelper.js` | Slack Web API wrapper (send, update, upload, user lookup, md-to-slack) |
| `src/emailHelper.js` | Nodemailer wrapper using Fastmail SMTP |
| `src/mdConverter.js` | Markdown to docx/html/pdf/txt via pandoc |
| `routes/mobey-agent.js` | Agent-facing endpoint, injects Slack token + channel |
| `routes/api/mobey.js` | Core endpoint: preprocessing, Claude CLI, Slack/email delivery |

---

## The Two Mobey Routes

### `/api/mobey-agent` (routes/mobey-agent.js)

Simple proxy for the OpenClaw agent. The agent POSTs `{ prompt, timeout?, thread_ts? }` and this route:

1. Validates the prompt
2. Injects Slack context (bot token from env, hardcoded channel `C0AF2HY0D5M`, optional thread_ts)
3. Forwards to `POST http://127.0.0.1:3100/mobey`
4. Proxies the response back

Localhost-only (403 for non-local IPs).

### `/mobey` (routes/api/mobey.js)

The real workhorse. Accepts `{ prompt, timeout?, slack? }` where `slack` contains `{ channel, thread_ts, sender_name }`.

**Flow:**

1. **Slack status** -- Posts an "On it!" message using the Slack Web API, storing the message ts for later updates. Builds a header like `*Nate Brown*: _explain the auth module..._`

2. **Preprocessing** -- Spawns a separate Claude CLI call (30s timeout, `--max-turns 1`) with a system prompt that extracts structured params from the raw user prompt:
   - `prompt` -- cleaned query with delivery instructions stripped
   - `format` -- md/txt/docx/html/pdf (default md)
   - `respond_email` -- email address, `true` (resolve from Slack profile), or null
   - `reply_inline` -- true/false/null
   - `short_prompt` -- 3-6 word topic label

3. **Claude CLI execution** -- Spawns `claude -p --verbose --output-format stream-json` with:
   - Working directory: `~/Projects/mobe3Full`
   - System prompt: "You are a code analyst for the mobe3 codebase... Do NOT generate new code..."
   - Timeout: 5 minutes (configurable)
   - Streams events (thinking, text, tool-call) back for optional live Slack updates (currently disabled via `STREAM_UPDATES = false`)

4. **Delivery** -- Decision tree:
   - Email requested + valid address? Send via Fastmail SMTP (html body or attachment depending on format)
   - Explicit format (docx/pdf/html/txt)? Upload file to Slack thread
   - Response < 1000 chars? Inline Slack message (markdown converted to Slack formatting)
   - Response >= 1000 chars? Upload as .md file to Slack

5. **HTTP response** -- Returns `{ status: "ok", markdown, prompt, durationMs }` or error with appropriate status code

**Concurrency:** Max 3 simultaneous requests (429 if exceeded).

---

## Claude CLI Integration

`src/claudeHelper.js` exports two functions:

**`claudeStream(prompt, options, onEvent)`** -- Spawns `claude -p --verbose --output-format stream-json`. Parses newline-delimited JSON events from stdout. Calls `onEvent(type, data)` for thinking/text/result events. Returns `{ markdown, durationMs }`. Uses `cleanEnv()` to strip Claude Code-specific env vars (`CLAUDECODE`, `CLAUDE_CODE*`, `NODE_OPTIONS`, `VSCODE*`, `ELECTRON*`) to avoid conflicts.

**`claudeQuery(prompt, options)`** -- Same but uses `--output-format json` (no streaming). Returns final result only.

Both support `{ cwd, systemPrompt, timeoutMs }` options. Timeout kills with SIGTERM, then SIGKILL after 5s.

---

## Claude WebSocket Server (claudeSocket.js)

Optional WebSocket server on port 3101 for remote Claude CLI access (e.g., from mobile via Tailscale). Only starts if `CLAUDE_SOCKET_TOKEN` is set.

Protocol: JSON over WebSocket. Client authenticates with a shared token (timing-safe comparison), then can start streaming sessions. Supports multiple concurrent sessions per connection, session abort, and heartbeat/keepalive.

---

## Slack Integration Details

`src/slackHelper.js` uses `@slack/web-api` with the Mobey bot token.

**Functions:** `sendSlackMessage`, `updateSlackMessage`, `uploadSlackFile`, `getUserInfo` (caches full user list, matches by name/display_name/real_name), `mdToSlack` (converts markdown headers to bold, bold to bold, italic to underscore, links to Slack format, strips images, preserves code blocks).

Note: `uploadSlackFile` uses `files.uploadV2` but has `thread_ts` commented out -- uploads go to the channel, not threaded.

---

## Email Integration

`src/emailHelper.js` uses nodemailer with Fastmail SMTP (smtp.fastmail.com:465, TLS). Sends from the configured Fastmail account as "Mobey". Supports text, html, cc/bcc, replyTo, and attachments.

When a user says "email me" without an address, the system resolves their email from their Slack profile via `getUserInfo`.

---

## Format Conversion

`src/mdConverter.js` shells out to **pandoc** for all conversions. Requires pandoc installed on the host. PDF conversion additionally needs a TeX distribution (`/Library/TeX/texbin` is added to PATH for macOS).

Supported: md -> docx, html, pdf, txt.

---

## OpenClaw Configuration

These live in OpenClaw's `openclaw.json`, not in this repo:

**Agent definition:**
- ID: `mobe3-technical`
- Model: `anthropic/claude-sonnet-4-5`
- Memory search enabled with extra paths: `mobe3-docs`
- Group chat history limit: 5

**Slack account (mobey):**
- Socket Mode (botToken + appToken)
- Channel: `C0AF2HY0D5M` (#mobey), `requireMention: false`

**Binding:** Routes all messages in #mobey from the mobey Slack account to `mobe3-technical` agent.

**Agent behavior:** Sends a snarky acknowledgment via OpenClaw's `message` tool immediately, then POSTs to `/api/mobey-agent`, waits for the response, and returns `NO_REPLY` (since Slack was already updated by the custom routes server).

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `PORT` | No (default 3100) | Express server port |
| `HOST` | No (default 0.0.0.0) | Bind address |
| `WORKSPACE_PATH` | Yes | Path to OpenClaw workspace (e.g., `/Users/nbrown/.openclaw/workspace`) |
| `OPENCLAW_GATEWAY` | Yes | Gateway URL (e.g., `http://127.0.0.1:18789`) |
| `OPENCLAW_GATEWAY_TOKEN` | Yes | Auth token for gateway WebSocket |
| `MOBEY_SLACK_BOT_TOKEN` | Yes | Slack bot token for the Mobey app (used by slackHelper) |
| `MOBEY_SLACK_TOKEN` | Yes | Slack bot token used by mobey-agent route (may be same as above) |
| `FASTMAIL_USER` | For email | Fastmail email address |
| `FASTMAIL_APP_PASSWORD` | For email | Fastmail app password |
| `CLAUDE_SOCKET_TOKEN` | For WebSocket | Shared secret for Claude WebSocket server |
| `CLAUDE_SOCKET_PORT` | No (default 3101) | Claude WebSocket server port |

---

## Dependencies

From `package.json`:

- `express` ^5.2.1 -- HTTP server
- `@slack/web-api` ^7.14.1 -- Slack API client
- `axios` ^1.13.5 -- HTTP client (mobey-agent proxy)
- `nodemailer` ^8.0.1 -- Email sending
- `ws` ^8.19.0 -- WebSocket (gateway + Claude socket server)
- `@noble/ed25519` ^3.0.0 -- Device identity signing
- `dotenv` ^17.3.1 -- Env var loading
- `gray-matter` ^4.0.3 -- Frontmatter parsing
- `pdc` ^0.2.3 -- (pandoc wrapper, though mdConverter shells out directly)

**System dependencies:** `claude` CLI, `pandoc`, TeX distribution (for PDF)

---

## Error Handling

- Preprocessing timeout: 30s (falls back to raw prompt)
- Claude CLI timeout: 5 min, SIGTERM then SIGKILL after 5s
- HTTP timeout: Claude timeout + 5s buffer
- Concurrency > 3: 429
- Non-localhost: 403
- Missing/invalid prompt: 400
- Claude killed: 504
- Claude error: 502
- Slack status message is updated with error text on failure

---

## Migration Checklist

To move this to a new platform, you need:

1. **Node.js runtime** with the `openclaw-custom-routes` repo and `npm install`
2. **Claude CLI** installed and authenticated on the host
3. **pandoc** installed (plus TeX for PDF generation)
4. **The mobe3Full codebase** at the expected path (or update `MOBE_DIR` in `routes/api/mobey.js`)
5. **OpenClaw instance** with gateway accessible, or replace the gateway connection with whatever orchestration layer you're moving to
6. **Slack app** with Socket Mode enabled, bot token with chat:write, files:write, users:read scopes
7. **Fastmail credentials** if email delivery is needed
8. **Environment variables** configured per the table above
9. **pm2 or equivalent** process manager to keep the server running
10. If using the Claude WebSocket feature: network path from mobile/remote device to port 3101 (Tailscale or similar)
