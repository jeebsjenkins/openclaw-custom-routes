# Code Change Agent

## Purpose

A DevOps-integrated agent that pulls work items from Azure DevOps, develops implementation plans, waits for human approval, then executes code changes and pushes to the correct customer branch and instance. Each customer instance has its own child agent (like the Implementation Agent), with access to the instance API, its git branch, and its Azure DevOps board.

This is the most complex agent — it spans DevOps project management, git operations, code generation, and deployment. The turn lifecycle is multi-phase with a human-in-the-loop approval gate.

## Architecture

```
codechange/                        ← Parent agent (shared code knowledge)
├── jvAgent.json
├── CLAUDE.md                      ← Coding standards, git workflow, PR conventions
├── tools/
│   ├── azdo.js                    ← Azure DevOps API client (work items, boards)
│   ├── git-ops.js                 ← Git operations (branch, commit, push, PR)
│   ├── instance-api.js            ← (inherited from impl/ or global tools)
│   └── instance-deploy.js         ← Push config/code to customer instance
├── memory/notes.md
│
├── acme/                          ← Customer: Acme Corp
│   ├── jvAgent.json
│   ├── CLAUDE.md                  ← Acme branch name, deployment specifics
│   ├── secrets.env                ← AZDO_PAT, GIT_TOKEN, INSTANCE_TOKEN
│   └── memory/notes.md
│
└── globex/
    └── ...
```

## Identity

| Field | Value |
|-------|-------|
| Parent Agent ID | `codechange` |
| Child Agent ID Pattern | `codechange/{customer}` |
| Display Name | Code Change Agent — {Customer Name} |
| Model | claude-sonnet-4-5-20250929 |

## Work Item Lifecycle

The agent operates on a multi-phase lifecycle per work item:

```
Phase 1: INTAKE
  Agent pulls work items from Azure DevOps (via heartbeat CRON or manual trigger)
  ↓
Phase 2: PLAN
  Agent reads the work item description, explores the codebase,
  develops an implementation plan, writes it to the DevOps tile
  DevOps tile state → "Plan Ready" / "Awaiting Approval"
  ↓
Phase 3: APPROVAL GATE (human-in-the-loop)
  Engineer reviews the plan in Azure DevOps
  Moves tile to "Approved" / rejects with feedback
  ↓
Phase 4: EXECUTE
  Agent picks up approved tiles (via heartbeat or subscription)
  Creates feature branch, implements changes, runs tests
  Pushes branch, creates PR
  DevOps tile state → "In Progress" → "PR Created"
  ↓
Phase 5: DEPLOY
  After PR merge (human action), agent pushes to customer instance
  DevOps tile state → "Deployed"
```

## Trigger Mechanisms

### 1. Heartbeat CRON — Poll for New Work Items

```json
// codechange/acme/jvAgent.json
{
  "heartbeat": "*/15 * * * *"
}
```

Every 15 minutes, the agent:
1. Queries Azure DevOps for tiles in "New" or "Approved" state
2. For "New" tiles → enters Phase 2 (plan)
3. For "Approved" tiles → enters Phase 4 (execute)

### 2. Broker Message — Explicit Trigger

Other agents or humans can trigger work:
```json
{
  "to": "agent/codechange/acme",
  "command": "work.process",
  "payload": { "workItemId": "12345" }
}
```

### 3. Slack — Status Updates

The agent posts status updates to a designated Slack channel and can receive feedback/commands.

## Agent Configuration

### Parent: codechange/jvAgent.json

```json
{
  "id": "codechange",
  "name": "Code Change Agent",
  "description": "Automated code change execution. Pulls DevOps work items, plans changes, executes after approval, deploys to customer instances.",
  "workDirs": [
    "~/Projects/openclaw-custom-routes"
  ],
  "defaultModel": "claude-sonnet-4-5-20250929",
  "subscriptions": [],
  "autoRun": { "enabled": false }
}
```

### Child: codechange/acme/jvAgent.json

```json
{
  "id": "codechange/acme",
  "name": "Code Change Agent — Acme Corp",
  "description": "Code changes for Acme Corp. Branch: customer/acme. DevOps project: AcmeImplementation.",
  "workDirs": [
    "~/Projects/openclaw-custom-routes"
  ],
  "defaultModel": "claude-sonnet-4-5-20250929",
  "subscriptions": [
    { "pattern": "agent/codechange/acme/**" }
  ],
  "autoRun": {
    "enabled": true,
    "triageModel": "haiku",
    "debounceMs": 5000,
    "maxBatchSize": 5
  },
  "heartbeat": "*/15 * * * *",
  "instance": {
    "url": "https://api.acme.example.com",
    "name": "Acme Corp"
  },
  "devops": {
    "organization": "yourorg",
    "project": "AcmeImplementation",
    "board": "Sprint Board",
    "stateMapping": {
      "new": "New",
      "planning": "Planning",
      "planReady": "Plan Ready",
      "approved": "Approved",
      "inProgress": "In Progress",
      "prCreated": "PR Created",
      "deployed": "Deployed",
      "rejected": "Rejected"
    }
  },
  "git": {
    "repo": "~/Projects/openclaw-custom-routes",
    "customerBranch": "customer/acme",
    "branchPrefix": "feature/acme-"
  }
}
```

### Secrets: codechange/acme/secrets.env

```env
# Azure DevOps
AZDO_PAT=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AZDO_ORG=yourorg
AZDO_PROJECT=AcmeImplementation

# Git (for push access)
GIT_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GIT_REMOTE=https://github.com/yourorg/openclaw-custom-routes.git

# Customer Instance
INSTANCE_API_TOKEN=Bearer eyJhbGciOiJSUzI1NiIs...
INSTANCE_URL=https://api.acme.example.com
```

### CLAUDE.md (Parent)

Covers:
- Git workflow: feature branches off `customer/{name}`, conventional commits, PR descriptions
- Code standards and patterns used in the project
- How to use azdo, git-ops, and instance-deploy tools
- Multi-phase work item lifecycle and state transitions
- Testing requirements before PR
- Memory update protocol: log every work item processed, lessons learned

### CLAUDE.md (Child — Customer-Specific)

Covers:
- Customer branch name and naming conventions
- Customer-specific code paths, config files, feature flags
- Deployment procedures for this customer
- Known gotchas and historical issues

## Required Tools

### azdo.js (NEW) ⚠️ CRITICAL

Azure DevOps REST API client.

```javascript
module.exports = {
  name: 'azdo',
  description: 'Azure DevOps work item management. Query, create, update tiles.',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['query', 'get', 'update', 'create', 'add-comment', 'list-comments'],
      },
      workItemId: { type: 'number', description: 'Work item ID (for get/update)' },
      wiql: { type: 'string', description: 'WIQL query (for query action)' },
      fields: { type: 'object', description: 'Fields to set (for create/update)' },
      comment: { type: 'string', description: 'Comment text (for add-comment)' },
    },
    required: ['action'],
  },
  async execute(input, context) {
    const { agentSecrets } = context;
    const pat = agentSecrets?.AZDO_PAT;
    const org = agentSecrets?.AZDO_ORG;
    const project = agentSecrets?.AZDO_PROJECT;
    // Use Azure DevOps REST API with PAT auth
    // Base URL: https://dev.azure.com/{org}/{project}/_apis/wit/workitems
  },
};
```

Key operations:
- **query** — WIQL query to find tiles by state (New, Approved, etc.)
- **get** — Fetch full work item details
- **update** — Change state, add plan to description, assign
- **create** — Create sub-tasks
- **add-comment** — Post status updates to the work item

### git-ops.js (NEW) ⚠️ CRITICAL

Git operations wrapper. Executes git commands in the agent's workDir.

```javascript
module.exports = {
  name: 'git-ops',
  description: 'Git operations: branch, commit, push, diff, status, create PR.',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'branch-create', 'checkout', 'diff', 'add', 'commit', 'push', 'pr-create', 'log'],
      },
      branch: { type: 'string' },
      message: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      baseBranch: { type: 'string', description: 'Base branch for new branch or PR' },
      prTitle: { type: 'string' },
      prBody: { type: 'string' },
    },
    required: ['action'],
  },
  async execute(input, context) {
    const { agentSecrets, agentId } = context;
    // Execute git commands via child_process
    // Use GIT_TOKEN for authenticated push
    // Enforce branch naming conventions from agent config
  },
};
```

### instance-deploy.js (NEW) ⚠️

Pushes configuration or code artifacts to a customer instance.

```javascript
module.exports = {
  name: 'instance-deploy',
  description: 'Deploy changes to a customer instance via their REST API.',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['push-config', 'push-code', 'verify', 'rollback'] },
      payload: { type: 'object' },
    },
    required: ['action'],
  },
  async execute(input, context) {
    const { agentSecrets } = context;
    // POST to instance API with deployment payload
    // Verify deployment via health check
  },
};
```

### Inherited/Existing Tools

| Tool | Purpose |
|------|---------|
| `send-message` | Post status to Slack, notify other agents |
| `grep-logs` | Search past execution history |
| `instance-api` | Query customer instance (shared with impl agent) |

## Session Strategy

### Work-Item-Keyed Sessions

Each Azure DevOps work item gets its own session. This provides:
- Complete execution history per work item
- Isolated memory (plan, approval status, execution notes)
- Resumable multi-phase work (plan → approval wait → execute)

**Session ID:** `wi-{workItemId}` (e.g., `wi-12345`)

### Session Lifecycle

```
Session created: wi-12345
  ↓ Phase 2: Plan
  Session memory: { phase: "planning", workItemId: 12345 }
  Agent writes plan, updates AzDO tile
  Session memory: { phase: "plan_ready", plan: "..." }
  ↓ Session paused (waiting for approval)
  ↓ Heartbeat polls AzDO, finds tile moved to "Approved"
  ↓ Phase 4: Execute
  Session resumed with full context
  Session memory: { phase: "executing", branch: "feature/acme-12345" }
  Agent implements, pushes, creates PR
  Session memory: { phase: "pr_created", prUrl: "..." }
  ↓ Session paused (waiting for merge)
  ↓ Heartbeat detects merge
  ↓ Phase 5: Deploy
  Session memory: { phase: "deployed", deployedAt: "..." }
  Session closed
```

## Infrastructure Gaps

### GAP 1: Secure Per-Agent Secrets ⚠️ CRITICAL

Same as Implementation Agent. This agent has MORE secrets (AzDO PAT, Git token, Instance token) and it's critical they're isolated per customer. A compromised Acme token must not affect Globex.

### GAP 2: Tool Inheritance for Nested Agents ⚠️ IMPORTANT

Same as Implementation Agent. `codechange/acme` must inherit tools from `codechange/tools/`.

### GAP 3: Azure DevOps Tool ⚠️ CRITICAL — NEW

No DevOps integration exists. The `azdo.js` tool needs:
- Azure DevOps REST API client (PAT-based auth)
- WIQL query support for finding work items by state
- Work item CRUD (get, update, create, comment)
- State transition tracking

**Dependency:** `axios` (already installed)

### GAP 4: Git Operations Tool ⚠️ CRITICAL — NEW

No git operations tool exists. The `git-ops.js` tool needs:
- Branch creation, checkout, commit, push
- PR creation via GitHub CLI (`gh`) or GitHub API
- Diff viewing for plan verification
- Authenticated push using per-agent GIT_TOKEN
- Branch naming enforcement from agent config

**Security concern:** Git push is a destructive operation. The tool must enforce:
- Only push to branches matching the agent's configured prefix
- Never push to `main` or `master`
- Require branch name to include the work item ID

### GAP 5: Multi-Phase Session Resumption ⚠️ IMPORTANT

**Current state:** Sessions resume via `--resume {sessionId}`, which continues the Claude CLI conversation. But multi-phase workflows need to pause between phases (waiting for human approval) and resume potentially hours or days later.

**What's needed:**
- Session metadata must track `phase` and `workItemId`
- Heartbeat should scan session metadata to find sessions in "waiting" phases
- When a waiting session's trigger condition is met (tile state changed), the session should be resumed with a new prompt ("The plan was approved. Proceeding to execution.")

**Proposed solution:** Add a `"pendingTrigger"` field to session metadata:
```json
{
  "pendingTrigger": {
    "type": "azdo_state_change",
    "workItemId": 12345,
    "targetState": "Approved",
    "resumePrompt": "Work item 12345 has been approved. Execute the plan."
  }
}
```

The heartbeat handler checks pending triggers and resumes sessions when conditions are met.

### GAP 6: Thread-to-Session Mapping

Same as other agents, but less critical here since this agent is primarily driven by DevOps events, not Slack threads.

### GAP 7: Agent Config Extension Fields

**Current state:** `jvAgent.json` has a fixed set of known fields. The `devops` and `git` config blocks proposed above are custom extensions.

**What's needed:** The project manager should pass through unknown fields in jvAgent.json without stripping them. Tools can then access them via `context.agentConfig` or similar.

**Proposed solution:** In `projectManager.getAgent()`, return the full parsed JSON (it likely already does this). Ensure tools can access it via context:
```javascript
// In toolLoader or agentTurnManager:
const agentConfig = projectManager.getAgent(agentId);
context.agentConfig = agentConfig;
```

### GAP 8: Execution Sandboxing

**Current state:** The Claude CLI runs with full filesystem access to the agent's workDir.

**Concern:** The code change agent will be modifying source code and running git operations. A malformed plan could:
- Modify files outside the intended scope
- Push to the wrong branch
- Delete code

**Proposed mitigations:**
- Git tool enforces branch naming and push restrictions
- Agent's workDir is a separate clone or worktree, not the main dev copy
- Pre-push hook validates branch name and diff size
- All changes are behind a PR (human review before merge)

## Estimated Effort

| Item | Effort |
|------|--------|
| Agent scaffolding (parent + one child) | Low |
| Per-agent secrets system | Medium — shared with impl agent |
| Azure DevOps tool (azdo.js) | Medium-High — full REST API client |
| Git operations tool (git-ops.js) | Medium — git CLI wrapper with guardrails |
| Instance deploy tool | Medium — depends on instance API |
| Multi-phase session resumption | High — new concept in turn manager |
| Pending trigger system | Medium — heartbeat enhancement |
| Tool inheritance | Low — shared with impl agent |
| Agent config passthrough to tools | Low |
| Execution sandboxing | Low-Medium — git worktree + hook |

---

## Security Considerations

1. **Secrets isolation** — Each customer's tokens must be completely isolated. A bug in the Acme agent must never leak Globex credentials.
2. **Git guardrails** — The git tool must refuse to push to protected branches, must include work item IDs in branch names, and must enforce conventional commits.
3. **Approval gate is non-bypassable** — The agent must NEVER execute code changes without the AzDO tile being in "Approved" state. The tool should verify state at execution time, not just rely on cached data.
4. **Audit trail** — Every action (AzDO update, git push, deployment) must be logged in the session's conversation log AND in agent memory.
5. **Rate limiting** — DevOps and instance APIs should have request rate limits in the tools to prevent runaway agents.
