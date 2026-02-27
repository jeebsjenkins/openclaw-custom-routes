# Implementation Agent

## Purpose

A customer-facing technical agent that understands the software's codebase AND a specific customer's live configuration. Each customer instance gets its own agent (a child agent), connected to that customer's REST API and optionally tied to a dedicated Slack channel. The agent recommends configurations, explains use cases, troubleshoots issues, and can query the customer's instance API to reference real data in its answers.

## Architecture: Parent + Per-Instance Children

```
impl/                          ← Parent agent (shared knowledge base)
├── jvAgent.json
├── CLAUDE.md                  ← General product knowledge, API patterns
├── tools/
│   ├── instance-api.js        ← REST API client (uses agent secrets)
│   └── config-recommender.js  ← Configuration suggestion engine
├── memory/notes.md            ← Cross-customer learnings
│
├── acme/                      ← Customer: Acme Corp
│   ├── jvAgent.json           ← Instance URL, Slack channel binding
│   ├── CLAUDE.md              ← Customer-specific context
│   ├── memory/notes.md        ← Acme-specific learnings
│   └── secrets.env            ← API_TOKEN, INSTANCE_URL ⚠️ NEW
│
├── globex/                    ← Customer: Globex Inc
│   ├── jvAgent.json
│   ├── CLAUDE.md
│   ├── memory/notes.md
│   └── secrets.env
│
└── initech/                   ← Customer: Initech
    └── ...
```

Each child agent ID is path-based: `impl/acme`, `impl/globex`, etc. They inherit the parent's tools (from `impl/tools/`) and add customer-specific configuration.

## Identity

| Field | Value |
|-------|-------|
| Parent Agent ID | `impl` |
| Child Agent ID Pattern | `impl/{customer}` |
| Display Name | Implementation Agent — {Customer Name} |
| Model | claude-sonnet-4-5-20250929 |
| Workspace | `evserp` |

## Slack Integration

### Binding: One Channel Per Customer

Each customer instance agent is bound to a specific Slack channel. When someone posts in `#acme-support`, only the `impl/acme` agent responds.

```json
// impl/acme/jvAgent.json
{
  "subscriptions": [
    { "pattern": "slack/evserp/#acme-support" }
  ]
}
```

The agent also handles `/mobey` commands issued from that channel.

### Message Flow

```
Support engineer posts in #acme-support: "Why is widget X returning 404?"
  ↓
Slack → broker → matches impl/acme subscription (slack/evserp/#acme-support)
  ↓
Triage → YES (it's in the agent's dedicated channel)
  ↓
Agent executes:
  1. Reads CLAUDE.md for Acme-specific context
  2. Calls instance-api tool: GET /api/widgets?name=X (using Acme's API token)
  3. Gets: { "widget_x": { "status": "disabled", "reason": "..." } }
  4. Searches source code for widget routing logic
  5. Composes answer with real data + code explanation
  6. Replies in thread via send-message → slack/evserp/#acme-support
```

## Agent Configuration

### Parent: impl/jvAgent.json

```json
{
  "id": "impl",
  "name": "Implementation Agent",
  "description": "Product implementation expert. Parent agent with shared tools and knowledge. Customer-specific instances are child agents.",
  "workDirs": [
    "~/Projects/openclaw-custom-routes"
  ],
  "defaultModel": "claude-sonnet-4-5-20250929",
  "subscriptions": [],
  "autoRun": {
    "enabled": false
  }
}
```

The parent agent doesn't auto-run — it's a knowledge base. Only child agents are active.

### Child: impl/acme/jvAgent.json

```json
{
  "id": "impl/acme",
  "name": "Implementation Agent — Acme Corp",
  "description": "Implementation support for Acme Corp. Connected to their instance at api.acme.example.com. Bound to #acme-support.",
  "workDirs": [
    "~/Projects/openclaw-custom-routes"
  ],
  "defaultModel": "claude-sonnet-4-5-20250929",
  "subscriptions": [
    { "pattern": "slack/evserp/#acme-support" }
  ],
  "autoRun": {
    "enabled": true,
    "triageModel": "haiku",
    "debounceMs": 3000,
    "maxBatchSize": 10
  },
  "instance": {
    "url": "https://api.acme.example.com",
    "name": "Acme Corp"
  }
}
```

### Secrets: impl/acme/secrets.env

```env
INSTANCE_API_TOKEN=Bearer eyJhbGciOiJSUzI1NiIs...
INSTANCE_URL=https://api.acme.example.com
INSTANCE_NAME=Acme Corp
```

This file is loaded by the secrets system (see Gap 1) and injected into tool context when the agent's tools execute.

### CLAUDE.md (Parent — shared instructions)

The parent CLAUDE.md covers:
- Product architecture and module overview
- Common configuration patterns and best practices
- How to use the instance-api tool to query customer data
- How to format responses for Slack
- How to recommend configurations based on use cases
- Always verify recommendations against the customer's live instance before suggesting changes

### CLAUDE.md (Child — customer-specific)

Each child's CLAUDE.md extends the parent with:
- Customer name and instance details
- Known customizations and special configurations
- Customer-specific terminology or workflows
- Historical issues and resolutions (also in memory/notes.md)
- Relevant Slack channel and team contacts

## Required Tools

### instance-api (NEW) ⚠️

The core tool for querying customer instances.

```javascript
// impl/tools/instance-api.js
module.exports = {
  name: 'instance-api',
  description: 'Query a customer instance REST API. Supports GET, POST, PUT, DELETE.',
  schema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], default: 'GET' },
      path: { type: 'string', description: 'API path (e.g. /api/widgets)' },
      query: { type: 'object', description: 'Query parameters' },
      body: { type: 'object', description: 'Request body (for POST/PUT)' },
      headers: { type: 'object', description: 'Additional headers' },
    },
    required: ['path'],
  },
  async execute(input, context) {
    const { agentSecrets, log } = context;

    const baseUrl = agentSecrets?.INSTANCE_URL || agentSecrets?.instance_url;
    const token = agentSecrets?.INSTANCE_API_TOKEN || agentSecrets?.instance_api_token;

    if (!baseUrl) return { output: 'No INSTANCE_URL configured in agent secrets', isError: true };

    // Build and execute the request using axios
    // Auth header from secrets
    // Return formatted response
  },
};
```

### config-recommender (NEW)

A tool that takes a use case description and returns recommended configuration based on product knowledge + the customer's current setup.

### Existing Tools

| Tool | Purpose |
|------|---------|
| `send-message` | Reply to Slack, route to other agents |
| `grep-logs` | Search conversation history |

## Session Strategy

Same as the Documentation Agent: **thread-keyed sessions**. Each Slack thread in the customer's channel becomes a session, preserving context for multi-turn troubleshooting conversations.

For long-running implementation projects, named sessions can be created manually (e.g., `"acme-migration-2026"`) with their own memory and workDirs.

## Directory Layout

```
impl/
├── jvAgent.json
├── CLAUDE.md                     ← Product knowledge, tool usage guides
├── memory/notes.md               ← Cross-customer patterns
├── tools/
│   ├── instance-api.js           ← ⚠️ NEW — REST API client
│   └── config-recommender.js     ← ⚠️ NEW — configuration advisor
├── workspace/
├── tmp/
│
├── acme/
│   ├── jvAgent.json              ← Channel binding, instance config
│   ├── CLAUDE.md                 ← Customer-specific context
│   ├── secrets.env               ← ⚠️ NEW — API_TOKEN, INSTANCE_URL
│   ├── memory/notes.md           ← Customer-specific learnings
│   ├── workspace/                ← Generated configs, docs for Acme
│   └── sessions/
│       ├── main.json
│       └── {thread_ts}.json
│
├── globex/
│   ├── ...
│
└── initech/
    └── ...
```

## Infrastructure Gaps

### GAP 1: Secure Per-Agent Secrets ⚠️ CRITICAL

**Current state:** No mechanism for per-agent secrets. All env vars are global process.env.

**What's needed for this agent:**
- Each customer instance agent needs its own API token and instance URL
- These must NOT be in jvAgent.json (which may be version-controlled)
- They must be available to the `instance-api` tool at execution time

**Proposed solution:** `secrets.env` file per agent, loaded by projectManager and injected into tool execution context as `context.agentSecrets`. See [Shared Infrastructure Gaps](#shared-infrastructure-gaps).

### GAP 2: Tool Inheritance for Nested Agents ⚠️ IMPORTANT

**Current state:** The toolLoader loads tools from `PROJECT_ROOT/tools/` (global) and `PROJECT_ROOT/{agentId}/tools/` (agent-local). For a nested agent like `impl/acme`, it would look in `impl/acme/tools/`.

**What's needed:** `impl/acme` should inherit tools from its parent `impl/tools/` without copying them. The toolLoader should walk up the agent path hierarchy.

**Proposed solution:** In `toolLoader._loadAgentTools()`, after loading `{agentId}/tools/`, also load `{parent}/tools/` for each parent in the path. E.g., for `impl/acme`: load `impl/acme/tools/` → `impl/tools/` → `tools/` (global). Agent-local tools override parent tools by name.

### GAP 3: Instance API Tool ⚠️ CRITICAL

**Current state:** No generic HTTP/REST API tool exists.

**What's needed:** A tool that:
- Makes authenticated HTTP requests to a configurable base URL
- Uses per-agent secrets for auth (Bearer token, API key, etc.)
- Handles pagination, error responses, rate limiting
- Returns formatted results suitable for Claude to interpret
- Optionally caches responses to avoid hammering the customer API

### GAP 4: Agent Provisioning CLI/API

**Current state:** Agents are created via `projectManager.createAgent()` or the WebSocket `agent.create` command. Creating a new customer instance requires manual setup of jvAgent.json, CLAUDE.md, secrets.env, and Slack channel subscription.

**What's needed:** A provisioning workflow (could be a tool, route, or CLI command):
```
provision-instance --agent impl/acme \
  --instance-url https://api.acme.example.com \
  --token "Bearer ey..." \
  --slack-channel acme-support \
  --customer-name "Acme Corp"
```

This would scaffold the child agent directory, write the configs, and register the subscription.

### GAP 5: Thread-to-Session Mapping

Same as Documentation Agent — see that document for details.

### GAP 6: CLAUDE.md Inheritance

**Current state:** Each agent has its own CLAUDE.md. No inheritance or composition.

**What's needed:** Child agents should inherit their parent's CLAUDE.md and append their own. When the CLI runs, it should see both the parent context (product knowledge) and the child context (customer specifics).

**Proposed solution:** The `_resolveAgentOptions` function concatenates CLAUDE.md files up the agent hierarchy into the systemPrompt. Or: add `--add-dir` for the parent agent directory so the CLI sees both CLAUDE.md files.

## Estimated Effort

| Item | Effort |
|------|--------|
| Agent scaffolding (parent + one child) | Low |
| Per-agent secrets system | Medium — new feature in projectManager + toolLoader |
| instance-api tool | Medium — HTTP client with auth, error handling |
| Tool inheritance for nested agents | Low — toolLoader path walk |
| CLAUDE.md inheritance | Low — systemPrompt concatenation |
| Agent provisioning helper | Low — could be a route or CLI script |
| Thread-to-session mapping | Medium — shared with docs agent |
