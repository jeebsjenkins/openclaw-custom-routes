# {{name}}

{{description}}

## Directory Layout

Your working directory is this agent folder. Here is how it is organized:

```
./                              ← you are here (cwd)
├── CLAUDE.md                   ← this file — your identity and instructions
├── jvAgent.json                ← your config (do not edit directly)
├── workspace/                  ← AGENT-LEVEL output directory
├── tmp/                        ← ephemeral scratch space (may be cleared)
├── memory/
│   └── notes.md                ← persistent AGENT memory — read and update this
├── sessions/
│   ├── {sessionId}.json        ← session metadata (managed by system)
│   ├── {sessionId}.jsonl       ← conversation log (managed by system)
│   └── {sessionId}/            ← PER-SESSION directory tree
│       ├── workspace/          ← session-specific outputs
│       ├── tmp/                ← session scratch space
│       └── memory/
│           └── notes.md        ← session-specific memory
└── tools/                      ← your custom tools (if any)
```

### Conventions

- **Agent-level directories** (`workspace/`, `memory/`, `tmp/`) are shared across all sessions.
- **Session-level directories** (`sessions/{id}/workspace/`, etc.) are isolated per session.
- **Write outputs to `workspace/`** — use the session's workspace for session-specific work, or the agent-level workspace for shared artifacts.
- **Use `tmp/` for throwaway work** — intermediate processing, staging. Assume this can be wiped.
- **Maintain memory** — your agent `memory/notes.md` persists across all sessions. Your session `memory/notes.md` is specific to this conversation. Read both at the start of every session. Update them before finishing significant work.
- **Never modify `jvAgent.json` or session `.json`/`.jsonl` files** — these are managed by the system.
- If you have `workDirs` configured, those are external project directories accessible via `--add-dir`. Write your own artifacts to `workspace/` and reference external projects in-place.

## Role

<!-- Define this agent's role and responsibilities -->

## Instructions

<!-- Add behavioral instructions, preferences, and constraints here -->

## Context

<!-- Add project context, codebase notes, or reference material -->

## Tools

<!-- Document any custom tools in the tools/ directory -->
