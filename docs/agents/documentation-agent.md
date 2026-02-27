# Documentation Agent

## Purpose

A Slack-connected agent that has access to the source code and answers technical questions. Users interact with it via `/mobey` slash commands or messages in the `#mobey` channel. The agent responds in threads, maintains full thread context for follow-up questions, and can search the codebase, generate documents, and post them back to Slack or email them.

## Identity

| Field | Value |
|-------|-------|
| Agent ID | `docs` |
| Display Name | Documentation Agent |
| Model | claude-sonnet-4-5-20250929 (fast + capable) |
| Workspace | `evserp` (Slack workspace) |

## Slack Integration

### Trigger Points

1. **Slash command** — `/mobey <question>` from any channel or DM
2. **Channel messages** — any message posted in `#mobey`
3. **Thread replies** — follow-up messages in a thread the agent already responded to

### Response Behavior

- All responses are posted as **threaded replies** to keep channels clean
- For `/mobey`, the initial ack says "Got it — processing..." and the real answer comes as a follow-up message in the channel (or ephemeral response)
- Thread context: when a user replies in a thread the agent started, the agent sees the full thread history and responds with that context

## Broker Configuration

### Subscriptions (jvAgent.json)

```json
{
  "subscriptions": [
    { "pattern": "slack/evserp/#mobey" },
    { "pattern": "slack/evserp/**" }
  ]
}
```

The agent subscribes broadly to `slack/evserp/**` so it receives slash commands routed from any channel. Triage filters out irrelevant messages.

### Message Flow

```
User types /mobey "how does the router work?"
  ↓
Slack Socket Mode → services/slack.js
  ↓
messageBroker.route("slack/evserp/Nathan Brown", "slack/evserp/#general", {
  command: "slack.slash",
  payload: { slashCommand: "/mobey", text: "how does the router work?", channelId, responseUrl, ... }
})
  ↓
Broker delivers to "docs" agent (matches slack/evserp/**)
  ↓
agentTurnManager triage → YES (slash command = always run)
  ↓
agentTurnManager _execute() → Claude CLI with source code access
  ↓
Agent searches code, writes answer, calls send-message tool:
  { to: "slack/evserp/#general", command: "slack.send",
    payload: { channelId: "C123", text: "The router works by...", thread_ts: "original.ts" } }
  ↓
Broker → Slack sender → webClient.chat.postMessage (threaded)
```

### Thread Context Flow

```
User replies in thread: "Can you show me the code for that?"
  ↓
Slack sends message event with thread_ts matching original conversation
  ↓
services/slack.js routes with payload.threadTs set
  ↓
Agent receives message in same session (keyed by thread)
  ↓
Session memory contains prior Q&A context
  ↓
Agent responds in same thread via thread_ts
```

## Agent Configuration

### jvAgent.json

```json
{
  "id": "docs",
  "name": "Documentation Agent",
  "description": "Answers technical questions about the codebase via Slack. Triggered by /mobey or #mobey channel messages. Searches code, generates docs, replies in threads.",
  "workDirs": [
    "~/Projects/openclaw-custom-routes"
  ],
  "defaultModel": "claude-sonnet-4-5-20250929",
  "subscriptions": [
    { "pattern": "slack/evserp/#mobey" },
    { "pattern": "slack/evserp/**" }
  ],
  "autoRun": {
    "enabled": true,
    "triageModel": "haiku",
    "debounceMs": 2000,
    "maxBatchSize": 10
  }
}
```

### CLAUDE.md (System Prompt)

The CLAUDE.md should instruct the agent to:
- Search the codebase using available tools (Read, Grep, Glob) before answering
- Always respond in Slack threads (pass `thread_ts` in send-message payload)
- Format responses for Slack (mrkdwn, not full markdown)
- When generating documents, write them to `workspace/` and share via Slack file upload or email
- Update `memory/notes.md` with frequently asked topics and discovered patterns
- For `/mobey` commands, identify the intent and handle accordingly

### Triage Rules

The triage prompt should auto-accept:
- Any `slack.slash` command where `slashCommand === "/mobey"`
- Any `slack.message` from `#mobey` channel
- Any `slack.message` with `threadTs` matching a thread the agent previously responded to

The triage should reject:
- Random channel chatter that isn't in `#mobey` or a known thread
- Bot messages, system messages

## Required Tools

### Existing (Available Now)

| Tool | Purpose |
|------|---------|
| `send-message` | Reply to Slack via broker |
| `grep-logs` | Search conversation history |

### New Tools Needed

| Tool | Purpose | Gap |
|------|---------|-----|
| `slack-thread-history` | Fetch full thread context from Slack API | **NEW** — needs Slack Web API access to call `conversations.replies` |
| `generate-document` | Write a document to workspace/ and return a shareable link | **NEW** — wraps file creation + optional Slack file upload |
| `email-document` | Email a generated document | **NEW** — wraps nodemailer with agent-level SMTP config |

## Session Strategy

### Thread-Keyed Sessions

Each Slack thread becomes its own session. This provides:
- Isolated conversation context per thread
- Thread-specific memory (what was discussed)
- Clean separation between unrelated questions

**Session ID derivation:** Use the `thread_ts` (or message `ts` if no thread yet) as the session ID. This maps 1:1 with Slack threads.

### Implementation Note

This requires a small enhancement: when the turn manager receives a `slack.slash` or `slack.message`, it should derive the session from `payload.threadTs || payload.ts` rather than using the default "main" session. See **Gap: Thread-to-Session Mapping** below.

## Directory Layout

```
docs/
├── jvAgent.json
├── CLAUDE.md
├── memory/notes.md          ← learned FAQ patterns, common questions
├── workspace/               ← generated documents
├── tmp/
├── tools/
│   ├── slack-thread-history.js
│   ├── generate-document.js
│   └── email-document.js
└── sessions/
    ├── main.json
    ├── {thread_ts}.json     ← one session per Slack thread
    └── {thread_ts}/
        ├── workspace/       ← docs generated for this thread
        └── memory/notes.md  ← what this thread was about
```

## Infrastructure Gaps

### GAP 1: Thread-to-Session Mapping ⚠️ CRITICAL

**Current state:** When a Slack message arrives via the broker, the turn manager routes it to the agent's "main" session (or whichever sessions match the subscription). There's no automatic mapping from a Slack thread to a specific agent session.

**What's needed:** A mechanism to create/resume sessions keyed by Slack thread_ts. Options:
1. **Service-level routing** — The Slack service (or a middleware) inspects `threadTs` and maps it to a session before the broker routes it. The broker would then deliver to the correct session.
2. **Agent-level routing** — The agent itself manages thread→session mapping in its CLAUDE.md instructions, looking up `threadTs` in session memory.
3. **Turn manager hook** — A pre-execution hook in the turn manager that derives sessionId from message metadata.

**Recommended:** Option 3 — add a `sessionMapper` callback to the turn manager that agents can configure. Default: use "main". For Slack agents: map `payload.threadTs → sessionId`.

### GAP 2: Slack Thread History Fetching ⚠️ IMPORTANT

**Current state:** The agent receives individual messages as they arrive. It doesn't have access to the full Slack thread history (previous messages in the thread before the agent was involved).

**What's needed:** A tool that calls `conversations.replies(channel, ts)` via the Slack Web API to fetch the full thread. This requires the bot token — which is in process.env but not available to agent tools.

**Solution:** Create a `slack-thread-history` tool that has access to the Slack Web API client (passed via tool context or imported directly).

### GAP 3: Secure Per-Agent Environment Variables ⚠️ IMPORTANT

**Current state:** All env vars are global (process.env). No way to give one agent different API keys than another.

**What's needed:** Agent-level secrets that are:
- Stored securely (not in jvAgent.json in plaintext)
- Injected into tool context when that agent's tools run
- Available to the Claude CLI subprocess if needed

**See:** [Infrastructure Gaps](#shared-infrastructure-gaps) section at bottom.

### GAP 4: File Upload to Slack

**Current state:** The Slack service can send text messages. It cannot upload files.

**What's needed:** `webClient.files.uploadV2()` support for sharing generated documents directly in Slack threads.

**Solution:** Add `slack.file_upload` as an outbound command in the Slack service, handling `{ channelId, thread_ts, filePath, filename, title }`.

### GAP 5: Triage Customization

**Current state:** Triage uses a generic prompt ("should this agent process these messages?"). For the docs agent, we want more specific logic — always accept `/mobey`, always accept `#mobey`, accept thread replies to known threads.

**What's needed:** Per-agent triage prompt override in jvAgent.json or CLAUDE.md. A `"triagePrompt"` field or a `triage.md` file the turn manager reads.

## Estimated Effort

| Item | Effort |
|------|--------|
| Agent scaffolding (config, CLAUDE.md, subscriptions) | Low — use existing createAgent |
| Thread-to-session mapping | Medium — turn manager enhancement |
| slack-thread-history tool | Low — Slack API call wrapper |
| Triage customization | Low — add triagePrompt field |
| File upload to Slack | Low — add handler to slack service |
| Email integration | Low — nodemailer is already a dependency |
