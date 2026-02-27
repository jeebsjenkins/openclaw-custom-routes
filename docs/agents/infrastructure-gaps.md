# Infrastructure Gaps — Consolidated

This document consolidates all gaps identified across the three agent specs (Documentation, Implementation, Code Change) and prioritizes them by impact and dependency.

## Priority Matrix

| # | Gap | Agents Affected | Priority | Effort |
|---|-----|----------------|----------|--------|
| 1 | Per-agent secure secrets | All 3 | **P0 — BLOCKER** | Medium |
| 2 | Thread-to-session mapping | Docs, Impl | **P0 — BLOCKER** | Medium |
| 3 | Tool inheritance for nested agents | Impl, CodeChange | **P1** | Low |
| 4 | Agent config passthrough to tools | Impl, CodeChange | **P1** | Low |
| 5 | Azure DevOps tool | CodeChange | **P1** | Medium-High |
| 6 | Git operations tool | CodeChange | **P1** | Medium |
| 7 | Instance API tool | Impl, CodeChange | **P1** | Medium |
| 8 | Slack thread history tool | Docs | **P1** | Low |
| 9 | Slack file upload | Docs | **P2** | Low |
| 10 | Multi-phase session resumption | CodeChange | **P2** | High |
| 11 | CLAUDE.md inheritance | Impl, CodeChange | **P2** | Low |
| 12 | Triage customization | All 3 | **P2** | Low |
| 13 | Agent provisioning helper | Impl, CodeChange | **P3** | Low |
| 14 | Execution sandboxing | CodeChange | **P3** | Low-Medium |

## Gap 1: Per-Agent Secure Secrets (P0)

**The single most important gap.** Without this, the Implementation and Code Change agents cannot function — they need per-customer API tokens, and the Documentation agent may need email SMTP credentials.

### Current State

All environment variables live in the root `.env` file and are globally available via `process.env`. The Claude CLI subprocess inherits these. There is no mechanism to give agent A different secrets than agent B.

### Proposed Design

#### Storage: `secrets.env` per agent

```
{agentId}/
├── jvAgent.json
├── secrets.env          ← NEW: agent-specific env vars
└── ...
```

Format is standard dotenv:
```env
INSTANCE_API_TOKEN=Bearer eyJ...
INSTANCE_URL=https://api.acme.example.com
AZDO_PAT=xxxx
```

#### Loading: projectManager

```javascript
// In projectManager.js — new function
function getAgentSecrets(agentId) {
  const secretsPath = path.join(agentDir(agentId), 'secrets.env');
  if (!fs.existsSync(secretsPath)) return {};
  const raw = fs.readFileSync(secretsPath, 'utf8');
  const secrets = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    secrets[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
  return secrets;
}
```

#### Injection: Tool Context

```javascript
// In toolLoader.executeTool():
const agentSecrets = projectManager.getAgentSecrets(agentId);
const fullContext = {
  agentId,
  sessionId,
  agentSecrets,     // ← NEW
  projectRoot,
  log,
  ...context,
};
```

#### Injection: CLI Subprocess (for Claude Code tools)

```javascript
// In claudeHelper.js claudeStream/claudeQuery:
// Merge agent secrets into subprocess env
const env = { ...cleanEnv(), ...agentSecrets };
const proc = spawn('claude', args, { cwd, stdio, env });
```

This requires threading `agentSecrets` through the CLI pool. The pool's `_resolve()` would also load secrets:

```javascript
function _resolve(agentFolder) {
  const proj = projectManager.getAgent(agentFolder);
  const secrets = projectManager.getAgentSecrets(agentFolder);
  return { cwd: expandHome(proj.path), ..., agentSecrets: secrets };
}
```

#### Security

- `secrets.env` files should be in `.gitignore`
- File permissions should be `600` (owner read/write only)
- projectManager should validate that secrets files aren't world-readable
- Secrets are never logged, never included in conversation logs

#### Nested Agent Secret Inheritance

For `impl/acme`, secrets are loaded from `impl/acme/secrets.env`. The parent's secrets (`impl/secrets.env`) are NOT inherited — each child must declare its own. This prevents accidental credential leakage.

### Implementation Checklist

- [ ] Add `getAgentSecrets(agentId)` to projectManager
- [ ] Update toolLoader to inject `agentSecrets` into context
- [ ] Update agentCLIPool `_resolve()` to load secrets
- [ ] Update claudeHelper to merge secrets into subprocess env
- [ ] Add `secrets.env` to `.gitignore`
- [ ] Add secrets.env template to `templates/agent/`

## Gap 2: Thread-to-Session Mapping (P0)

### Current State

When a Slack message arrives via the broker, the turn manager routes it to the agent's matching subscription but always uses the "main" session (or the session that owns the subscription). There's no way to automatically map a Slack thread to a unique session.

### Why This Matters

Without thread→session mapping:
- All Slack conversations land in one session, mixing context
- The agent can't distinguish between different support threads
- Follow-up messages lose the context of the original question

### Proposed Design

#### Session Mapper Callback

Add a configurable `sessionMapper` function to the turn manager that derives a sessionId from the message:

```javascript
// In agentTurnManager config:
{
  "sessionMapper": "slack-thread"  // built-in mapper name
}
```

Built-in mappers:
- `"default"` — always uses "main"
- `"slack-thread"` — uses `payload.threadTs || payload.ts` as sessionId
- `"work-item"` — uses `payload.workItemId` as sessionId (for CodeChange agent)

#### Turn Manager Enhancement

```javascript
function _onSessionDelivery(agentId, sessionId, routeResult) {
  const config = _resolveConfig(agentId, sessionId);
  if (!config.enabled) return;

  // Apply session mapper if configured
  const mappedSessionId = _mapSession(agentId, routeResult, config);

  // Auto-create session if it doesn't exist
  if (mappedSessionId !== 'main') {
    try {
      projectManager.getSession(agentId, mappedSessionId);
    } catch {
      projectManager.createSession(agentId, mappedSessionId, {
        title: `Thread ${mappedSessionId}`,
        autoCreated: true,
      });
    }
  }

  _enqueue(agentId, mappedSessionId, routeResult, config);
}
```

### Implementation Checklist

- [ ] Add `sessionMapper` field to jvAgent.json schema
- [ ] Implement built-in mappers (default, slack-thread, work-item)
- [ ] Update `_onSessionDelivery` to apply mapper
- [ ] Auto-create sessions for new thread IDs
- [ ] Session cleanup: GC sessions older than N days with no activity

## Gap 3: Tool Inheritance for Nested Agents (P1)

### Current State

toolLoader loads from two locations: `PROJECT_ROOT/tools/` (global) and `PROJECT_ROOT/{agentId}/tools/` (agent-local).

For `impl/acme`, it looks in `impl/acme/tools/` — but the shared tools are in `impl/tools/`.

### Proposed Fix

Walk up the agent path hierarchy:

```javascript
function _getToolDirs(agentId) {
  const dirs = [];
  // Agent-local (highest priority)
  dirs.push(path.join(projectRoot, agentId, 'tools'));
  // Walk up parent hierarchy
  const parts = agentId.split('/');
  while (parts.length > 1) {
    parts.pop();
    dirs.push(path.join(projectRoot, parts.join('/'), 'tools'));
  }
  // Global (lowest priority)
  dirs.push(path.join(projectRoot, 'tools'));
  return dirs;
}
```

Tools from more specific paths override tools with the same name from parent paths.

## Gap 4: Agent Config Passthrough to Tools (P1)

### Current State

Tools receive `{ agentId, sessionId, projectRoot, log, messageBroker }`. They don't receive the agent's full config (jvAgent.json).

### Why This Matters

The Code Change agent's tools need access to `devops` and `git` config blocks. The Implementation agent's tools need `instance` config.

### Proposed Fix

```javascript
// In toolLoader.executeTool():
const agentConfig = projectManager.getAgent(agentId);
const fullContext = {
  agentId,
  sessionId,
  agentConfig,      // ← full jvAgent.json contents
  agentSecrets,
  projectRoot,
  log,
  ...context,
};
```

Low effort, high value.

## Gap 5: Azure DevOps Tool (P1)

New tool needed. See code-change-agent.md for full spec.

Core operations needed:
- WIQL query for work items by state
- Get work item details
- Update work item fields (state, description, assigned to)
- Add comments to work items
- Auth via Personal Access Token (PAT) from agent secrets

The Azure DevOps REST API is well-documented. Base URL: `https://dev.azure.com/{org}/{project}/_apis/`. Auth: Basic with empty username and PAT as password.

## Gap 6: Git Operations Tool (P1)

New tool needed. See code-change-agent.md for full spec.

Must include guardrails:
- Branch name validation (must match agent's configured prefix)
- Protected branch list (never push to main/master)
- Commit message conventions
- Diff size limits (warn on large diffs)
- Authenticated push via GIT_TOKEN from agent secrets

## Gap 7: Instance API Tool (P1)

Shared between Implementation and Code Change agents. Generic HTTP REST client that:
- Uses `INSTANCE_URL` and `INSTANCE_API_TOKEN` from agent secrets
- Supports GET, POST, PUT, DELETE
- Handles pagination, error codes, rate limiting
- Returns structured results

## Gap 8: Slack Thread History Tool (P1)

Wraps `conversations.replies(channel, ts)` to fetch full thread history. Needs the bot token — either from process.env or from agent secrets.

## Gap 9: Slack File Upload (P2)

Add `slack.file_upload` command to the Slack service outbound handler. Uses `webClient.files.uploadV2()`.

## Gap 10: Multi-Phase Session Resumption (P2)

The Code Change agent needs sessions that pause between phases and resume when external conditions are met. See code-change-agent.md for the `pendingTrigger` design.

This is the highest-effort gap and could be deferred initially by having the heartbeat re-evaluate all work items from scratch each time (stateless approach).

## Gap 11: CLAUDE.md Inheritance (P2)

Nested agents should see their parent's CLAUDE.md plus their own. Options:
1. Concatenate into `--system-prompt`
2. Add parent directory as `--add-dir` so Claude CLI sees both

Option 2 is simpler and already supported by the CLI options.

## Gap 12: Triage Customization (P2)

Allow agents to provide custom triage prompts via a `triage.md` file or `"triagePrompt"` field in jvAgent.json.

## Gap 13: Agent Provisioning Helper (P3)

Script or route to scaffold a new customer instance agent with config, secrets, and subscriptions.

## Gap 14: Execution Sandboxing (P3)

Git worktrees for isolated code changes. Pre-push hooks. Branch protection enforcement in the git tool.

---

## Implementation Order

Recommended phased approach:

### Phase 1: Foundation (enables all 3 agents)
1. Per-agent secrets system (Gap 1)
2. Agent config passthrough to tools (Gap 4)
3. Tool inheritance for nested agents (Gap 3)
4. CLAUDE.md inheritance (Gap 11)

### Phase 2: Documentation Agent
5. Thread-to-session mapping (Gap 2)
6. Slack thread history tool (Gap 8)
7. Triage customization (Gap 12)
8. Deploy and test docs agent

### Phase 3: Implementation Agent
9. Instance API tool (Gap 7)
10. Agent provisioning helper (Gap 13)
11. Deploy and test with one customer

### Phase 4: Code Change Agent
12. Azure DevOps tool (Gap 5)
13. Git operations tool (Gap 6)
14. Multi-phase session resumption (Gap 10)
15. Instance deploy tool
16. Execution sandboxing (Gap 14)
17. Deploy and test with one customer
