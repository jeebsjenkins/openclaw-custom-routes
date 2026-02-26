# Messaging Architecture

Describes the unified message broker, path-based routing, WebSocket protocol, and how messaging relates to the rest of the system.

---

## What Goes Through the Broker

The messageBroker handles **two categories** of traffic:

1. **Agent-to-agent messaging** — one agent sends a command or data to another agent
2. **External inbound routing** — messages from Slack, email, webhooks, or custom integrations are routed to subscribing agents

Everything else in the WebSocket protocol is **direct request/response** between the Swift client and the server, bypassing the broker entirely:

| Namespace | Handler | Goes through broker? |
|-----------|---------|---------------------|
| `msg.*` (11 handlers) | messageBroker | Yes |
| `msg.session.*` (6 handlers) | messageBroker (session-level) | Yes |
| `agent.*` (CRUD, claudemd) | projectManager | No |
| `session.*` (start, continue, abort) | claudeStreamFn | No |
| `agent.tools.*` (list, refresh, execute) | toolLoader | No |
| `logs.*` (search, conversations) | logScanner | No |
| `ping` / `pong` | inline | No |

The broker is not a transport layer for the whole system. It is specifically the **inter-agent communication and external inbound routing layer**.

---

## Path-Based Addressing

Every message has a delivery path. Paths use `/` as a separator. The first segment identifies the domain:

```
agent/{id}                         — direct message to an agent
agent/{parent}/**                  — agent subtree (broadcast pattern)
slack/{workspace}/#{channel}       — Slack channel
slack/{workspace}/@{user}          — Slack DM
email/{to}@domain/{from}@domain    — email thread
webhook/{service}/{topic}          — webhook event
{anything}/{else}                  — custom path
```

### Wildcard Matching

Two wildcard types are supported in subscription patterns:

- `*` matches exactly **one** path segment
- `**` matches **zero or more** segments

The `*` wildcard must be the entire segment. `#*` is a literal string, not a partial wildcard. Use `slack/*/*` to match all channels across all workspaces, not `slack/*/#*`.

Examples:

| Pattern | Path | Match? |
|---------|------|--------|
| `agent/researcher` | `agent/researcher` | Yes (exact) |
| `agent/*` | `agent/researcher` | Yes (* = researcher) |
| `agent/*` | `agent/a/b` | No (* is one segment) |
| `agent/**` | `agent/a/b/c` | Yes (** = a/b/c) |
| `agent/**` | `agent` | Yes (** = zero segments) |
| `slack/*/*` | `slack/team/#general` | Yes |
| `email/**` | `email/to@co.com/from@x.com` | Yes |

### Bidirectional Matching

When routing a message, the broker checks both directions:

1. Does the **subscription pattern** match the **delivery path**? (normal case: sub `slack/**` matches path `slack/team/#general`)
2. Does the **delivery path** match the **subscription pattern**? (broadcast case: path `agent/**` matches sub `agent/researcher`)

This bidirectional check is what makes `broadcast()` work — the delivery path `agent/**` is treated as a pattern that matches each agent's auto-subscription.

---

## Subscription Model

### Auto-Subscriptions

Every agent is automatically subscribed to `agent/{its-own-id}`. These are computed on startup from `projectManager.listAgents()` and are **not persisted**. You cannot unsubscribe from your own auto-subscription.

### Custom Subscriptions (Agent-Level)

Agents can subscribe to arbitrary path patterns. Custom subscriptions are persisted in the agent's `jvAgent.json` under the `subscriptions` array:

```json
{
  "subscriptions": [
    { "pattern": "slack/team/#general", "addedAt": 1708900000000 },
    { "pattern": "email/**", "addedAt": 1708900000000 }
  ]
}
```

### Session-Level Subscriptions

Sessions can also subscribe to paths. A session IS the agent in a specific conversational context — the "main" session is the generic agent catch-all, while specialized sessions focus on specific message paths. Sessions are persistent and reactive: they "wake up" when an inbound message matches their subscription.

Session subscriptions are persisted in the session's `.json` file:

```json
{
  "id": "slack-monitor",
  "title": "Slack channel monitor",
  "isDefault": false,
  "subscriptions": [
    { "pattern": "slack/team/#general", "addedAt": 1708900000000 }
  ],
  "createdAt": 1708900000000,
  "lastUsedAt": 1708900000000
}
```

### Cascade Delivery

When a message matches both a session subscription and its parent agent's subscription, **both receive the message**. The agent's copy is flagged with `handled: true` and includes a `handledBy` array listing which sessions handled it. When no sessions match, the agent gets `handled: false`.

This lets agents implement "unhandled only" logic: they can inspect the `handled` flag and skip messages that a specific session already processed.

### Indexes

The broker maintains four in-memory indexes for fast lookup:

- **Agent forward index** (`pattern → Set<agentId>`) — agent subscriptions by pattern
- **Agent reverse index** (`agentId → Set<pattern>`) — patterns by agent
- **Session forward index** (`pattern → Set<"agentId:sessionId">`) — session subscriptions by pattern
- **Session reverse index** (`"agentId:sessionId" → Set<pattern>`) — patterns by session

All are rebuilt from disk on startup via `rebuildIndex()`.

---

## Message Format

Every message flowing through the broker has this structure:

```json
{
  "id": "uuid-v4",
  "from": "writer",
  "path": "agent/researcher",
  "command": "analyze",
  "payload": { "topic": "AI safety" },
  "status": "pending",
  "timestamp": 1708900000000,
  "source": "internal",
  "externalId": null
}
```

| Field | Description |
|-------|-------------|
| `id` | UUID, generated by the broker |
| `from` | Sender agent ID or system identifier |
| `path` | Normalized delivery path |
| `command` | Action verb (defaults to `"message"`) |
| `payload` | Arbitrary data object (defaults to `{}`) |
| `status` | `"pending"` on creation, `"delivered"` after `receive()` |
| `timestamp` | Unix milliseconds |
| `source` | `"internal"` for agent-to-agent, or `"slack"`, `"email"`, `"webhook"` etc. |
| `externalId` | External system message ID (e.g. Slack `thread_ts`, email `Message-ID`) |
| `handled` | `true` if a session already processed this message, `false` otherwise (agent copies only) |
| `handledBy` | Array of `{ agentId, sessionId }` that handled this message (present when `handled: true`) |

---

## Core API

The broker is created via factory function:

```javascript
const broker = createMessageBroker(projectRoot, projectManager, log);
```

### Routing

| Method | Description |
|--------|-------------|
| `route(from, path, message)` | Universal router. Finds all matching subscribers, persists per-agent, emits via EventEmitter, dead-letters unmatched. |
| `send(from, toAgentId, message)` | Sugar for `route(from, 'agent/' + toAgentId, message)` |
| `broadcast(from, message)` | Sugar for `route(from, 'agent/**', message)`. Excludes sender. |

### Receiving (Agent-Level)

| Method | Description |
|--------|-------------|
| `receive(agentId)` | Returns pending messages, marks them as delivered. Polling-based. |
| `listen(agentId, callback)` | Real-time delivery via EventEmitter. Returns an unsubscribe function. |
| `history(agentId, { limit, fromTime, toTime })` | Read message history (all statuses). |

### Receiving (Session-Level)

| Method | Description |
|--------|-------------|
| `receiveSession(agentId, sessionId)` | Returns pending messages for a session, marks delivered. |
| `listenSession(agentId, sessionId, callback)` | Real-time delivery for a specific session. Returns unsub fn. |
| `sessionHistory(agentId, sessionId, options)` | Read session message history. |

### Agent Subscriptions

| Method | Description |
|--------|-------------|
| `subscribe(agentId, pattern)` | Add a custom subscription. Persists to `jvAgent.json`. |
| `unsubscribe(agentId, pattern)` | Remove a custom subscription. Cannot remove auto-subs. |
| `getSubscriptions(agentId)` | List custom subscriptions (excludes auto-sub). |
| `rebuildIndex()` | Rebuild all indexes from disk. Call after external config changes. |

### Session Subscriptions

| Method | Description |
|--------|-------------|
| `subscribeSession(agentId, sessionId, pattern)` | Add subscription for a session. Persists to session `.json`. |
| `unsubscribeSession(agentId, sessionId, pattern)` | Remove a session subscription. |
| `getSessionSubscriptions(agentId, sessionId)` | List session subscriptions. |

### Dead-Letter Queue

| Method | Description |
|--------|-------------|
| `getUnmatched({ limit, fromTime, toTime })` | Read unmatched messages. |
| `clearUnmatched()` | Empty the dead-letter log. |

### Utilities

| Method | Description |
|--------|-------------|
| `pathMatches(pattern, path)` | Test if a pattern matches a path. Exported for testing. |

---

## Delivery Flow

When `route(from, path, message)` is called:

```
1. Normalize the path (strip leading/trailing slashes)
2. Build message object (UUID, timestamp, defaults)
3. Find matching subscribers:
   a. Check agent auto-subscriptions (bidirectional match)
   b. Check agent custom subscriptions (bidirectional match)
   c. Check session subscriptions (bidirectional match)
   d. When a session matches, its parent agent is also added to agent set (cascade)
   e. Exclude sender from broadcast-style agent/** paths
4. If no matches (agents + sessions):
   → Append to .messages/broker-unmatched.jsonl
   → Return { delivered: false, unmatched: true }
5. For each matched session:
   a. Append to .messages/session--{agentId}--{sessionId}.jsonl
   b. Emit via EventEmitter ('session:{agentId}:{sessionId}' event)
6. For each matched agent:
   a. Set handled=true if any of this agent's sessions matched, else handled=false
   b. Include handledBy array when handled=true
   c. Append to .messages/agent--{id}.jsonl
   d. Emit via EventEmitter ('agent:{id}' event)
7. Return { delivered: true, deliveredTo: [...agentIds], deliveredToSessions: [...] }
```

---

## Persistence

All message data lives under `{projectRoot}/.messages/`:

| File | Contents |
|------|----------|
| `agent--{id}.jsonl` | All messages delivered to this agent |
| `session--{agentId}--{sessionId}.jsonl` | Messages delivered to a specific session |
| `broker-unmatched.jsonl` | Messages with no matching subscribers |

Files are JSONL (one JSON object per line, newline-delimited). Messages survive broker restarts since they are read from disk on `receive()` and `history()`.

Agent subscriptions are persisted in each agent's `jvAgent.json`. Session subscriptions are persisted in each session's `.json` file within the agent's `sessions/` directory.

---

## WebSocket Protocol (msg.* namespace)

These are the 11 WebSocket message types that interact with the broker. All require authentication first.

### Sending

**msg.send** — Direct message to an agent
```json
→ { "type": "msg.send", "from": "writer", "to": "researcher", "command": "analyze", "payload": {} }
← { "type": "msg.send.ok", "messageId": "uuid", "message": { ... } }
```

**msg.route** — Route to an arbitrary path
```json
→ { "type": "msg.route", "from": "slack-bridge", "path": "slack/team/#general", "command": "new_message", "payload": {}, "source": "slack", "externalId": "ts-1234" }
← { "type": "msg.route.ok", "delivered": true, "deliveredTo": ["researcher"] }
```

**msg.broadcast** — Broadcast to all agents (excludes sender)
```json
→ { "type": "msg.broadcast", "from": "writer", "command": "announce", "payload": {} }
← { "type": "msg.broadcast.ok", "messageId": "uuid", "message": { ... } }
```

### Receiving

**msg.receive** — Poll for pending messages
```json
→ { "type": "msg.receive", "agentId": "researcher" }
← { "type": "msg.receive.ok", "agentId": "researcher", "messages": [ ... ] }
```

**msg.listen** — Subscribe to real-time push
```json
→ { "type": "msg.listen", "agentId": "researcher" }
← { "type": "msg.listen.ok", "agentId": "researcher" }
← { "type": "msg.push", "message": { ... } }  (pushed on each new message)
```

**msg.history** — Read message history
```json
→ { "type": "msg.history", "agentId": "researcher", "options": { "limit": 50 } }
← { "type": "msg.history.ok", "agentId": "researcher", "messages": [ ... ] }
```

### Subscription Management

**msg.sub.add** — Subscribe to a path pattern
```json
→ { "type": "msg.sub.add", "agentId": "researcher", "pattern": "slack/team/#general" }
← { "type": "msg.sub.add.ok", "agentId": "researcher", "pattern": "slack/team/#general", "subscriptions": [ ... ] }
```

**msg.sub.remove** — Unsubscribe from a pattern
```json
→ { "type": "msg.sub.remove", "agentId": "researcher", "pattern": "slack/team/#general" }
← { "type": "msg.sub.remove.ok", ... }
```

**msg.sub.list** — List custom subscriptions
```json
→ { "type": "msg.sub.list", "agentId": "researcher" }
← { "type": "msg.sub.list.ok", "agentId": "researcher", "subscriptions": [ { "pattern": "slack/**", "addedAt": 1708900000000 } ] }
```

### Dead-Letter

**msg.unmatched** — Read unmatched messages
```json
→ { "type": "msg.unmatched", "options": { "limit": 50 } }
← { "type": "msg.unmatched.ok", "messages": [ ... ] }
```

**msg.unmatched.clear** — Clear the dead-letter log
```json
→ { "type": "msg.unmatched.clear" }
← { "type": "msg.unmatched.clear.ok", "cleared": true }
```

### Session Subscriptions (msg.session.*)

**msg.session.sub.add** — Subscribe a session to a path pattern
```json
→ { "type": "msg.session.sub.add", "agentId": "researcher", "sessionId": "slack-monitor", "pattern": "slack/team/#general" }
← { "type": "msg.session.sub.add.ok", "agentId": "researcher", "sessionId": "slack-monitor", "subscriptions": [ ... ] }
```

**msg.session.sub.remove** — Unsubscribe a session
```json
→ { "type": "msg.session.sub.remove", "agentId": "researcher", "sessionId": "slack-monitor", "pattern": "slack/team/#general" }
← { "type": "msg.session.sub.remove.ok", ... }
```

**msg.session.sub.list** — List session subscriptions
```json
→ { "type": "msg.session.sub.list", "agentId": "researcher", "sessionId": "slack-monitor" }
← { "type": "msg.session.sub.list.ok", "subscriptions": [ ... ] }
```

**msg.session.listen** — Real-time push for a session
```json
→ { "type": "msg.session.listen", "agentId": "researcher", "sessionId": "slack-monitor" }
← { "type": "msg.session.listen.ok", ... }
← { "type": "msg.session.push", "agentId": "researcher", "sessionId": "slack-monitor", "message": { ... } }
```

**msg.session.receive** — Poll pending for a session
```json
→ { "type": "msg.session.receive", "agentId": "researcher", "sessionId": "slack-monitor" }
← { "type": "msg.session.receive.ok", "messages": [ ... ] }
```

**msg.session.history** — Session message history
```json
→ { "type": "msg.session.history", "agentId": "researcher", "sessionId": "slack-monitor", "options": { "limit": 50 } }
← { "type": "msg.session.history.ok", "messages": [ ... ] }
```

---

## Tool: send-message

Agents can also send messages via the `send-message` tool (available to all agents via `tools/send-message.js`). It wraps `messageBroker.route()` and auto-detects whether the `to` field is an agent ID or a full path:

- `{ to: "researcher" }` → routes to `agent/researcher`
- `{ to: "slack/team/#general" }` → routes to the full path
- Any `to` containing `/` or starting with a known prefix (`agent/`, `slack/`, `email/`, `webhook/`, `custom/`) is treated as a full path

The tool is injected into the execution context as `context.messageBroker`, so agents running via `agent.tool.execute` can send messages programmatically.

---

## Real-Time Delivery

The broker uses Node's `EventEmitter` for real-time push:

- Agent messages emit on `agent:{agentId}` → pushed as `msg.push` via `msg.listen`
- Session messages emit on `session:{agentId}:{sessionId}` → pushed as `msg.session.push` via `msg.session.listen`

Listener cleanup happens automatically when the WebSocket connection closes — all `_mbSubscriptions` unsub functions are called (covers both agent and session listeners).

The emitter max listeners is set to 200 to accommodate many simultaneous agent listeners.

---

## Sender Exclusion on Broadcast

When a message path starts with `agent/` and is not an exact direct message to the sender (`agent/{senderId}`), the sender is excluded from the matched set. This prevents an agent from receiving its own broadcasts.

An agent **can** send a message to itself via `send('researcher', 'researcher', ...)` — direct self-messaging is allowed, only broadcast self-delivery is excluded.

---

## Agent Turn Manager

The `agentTurnManager` bridges message delivery and agent execution. Without it, messages land in the broker and wait — nothing processes them automatically. With it, inbound messages trigger agent turns.

### Two-Stage Process

**Stage 1 — Triage (lightweight, fast model):** A quick API call using a cheap model (default: Haiku) that decides whether the agent should respond. The triage prompt includes the agent's role, session context, and the inbound message(s). Returns YES or NO. If triage fails (CLI error, timeout), defaults to YES to avoid missing messages.

**Stage 2 — Execution (full Claude CLI):** If triage approves, runs a full agent turn via `agentCLIPool` with `--resume <sessionId>` to preserve session context. The agent has access to its CLAUDE.md instructions, tools, and conversation history. Responses (including `send-message` tool calls) flow back through the broker.

### Debouncing

Messages are batched per session with a configurable debounce window (default 3 seconds). A burst of Slack messages becomes one agent turn, not many. If the batch reaches `maxBatchSize` (default 20), it flushes immediately without waiting for the debounce.

### Concurrency

Only one turn runs per session at a time. Messages arriving during an active turn are queued and trigger a re-run after the current turn completes.

### Configuration

Enable automatic turns per-agent (in `jvAgent.json`) or per-session (in session `.json`). Session config overrides agent config:

```json
{
  "autoRun": {
    "enabled": true,
    "triageModel": "haiku",
    "debounceMs": 3000,
    "maxBatchSize": 20
  }
}
```

Or as a simple boolean: `"autoRun": true` (uses global defaults).

### Route Hooks

The broker exposes `onRoute(callback)` which fires after every successful delivery. The turn manager hooks in here to watch all deliveries and trigger turns for sessions/agents with `autoRun` enabled.

### Conversation Logging

Auto-turns are logged to the session's conversation history with `type: "auto-turn"` (inbound context) and `type: "auto-turn-result"` (agent response), so the conversation log tracks both human-initiated and auto-triggered turns.

### Manual Trigger

`triggerTurn(agentId, sessionId, messages)` bypasses triage and goes straight to execution. Useful for the Swift client to force an agent turn on demand.

---

## System Wiring

In `server.js`, the broker, turn manager, and socket server are created and connected:

```javascript
const messageBroker = createMessageBroker(config.projectRoot, projectManager, log);

const turnManager = createAgentTurnManager({
  messageBroker,
  projectManager,
  agentCLIPool,
  log,
});
turnManager.start();

claudeSocket.start({
  port: config.claudeSocketPort,
  token: config.claudeSocketToken,
  claudeStreamFn: claudeStream,
  projectManager,
  toolLoader,
  messageBroker,
  logScanner,
  agentCLIPool,
  log,
});
```

The broker requires `projectRoot` (for `.messages/` storage) and `projectManager` (for agent listing and subscription persistence). The turn manager requires the broker (for `onRoute` hook), `projectManager` (for config resolution), and `agentCLIPool` (for CLI execution). All indexes are rebuilt on construction.
