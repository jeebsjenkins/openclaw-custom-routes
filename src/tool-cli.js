#!/usr/bin/env node
/**
 * tool-cli.js — Bash-callable bridge to server-side tools.
 *
 * The Claude CLI agent calls this via Bash. It connects to the running
 * WebSocket server, authenticates, executes the tool, prints the result
 * to stdout, and exits. The agent never sees secrets — they're injected
 * server-side by toolLoader.
 *
 * Usage:
 *   node tool-cli.js <toolName> [--agent <agentId>] [--session <sessionId>] [--input '<json>']
 *   node tool-cli.js list [--agent <agentId>]
 *
 * Examples:
 *   node tool-cli.js service-status --agent main --input '{"action":"list"}'
 *   node tool-cli.js send-message --agent main --input '{"to":"researcher","command":"analyze","payload":{"text":"hello"}}'
 *   node tool-cli.js git-ops --agent impl/acme --input '{"action":"status"}'
 *   node tool-cli.js list --agent main
 *
 * Environment:
 *   CLAUDE_SOCKET_PORT  — WebSocket port (default: 3101)
 *   CLAUDE_SOCKET_TOKEN — Auth token (required)
 *   TOOL_AGENT_ID       — Default agent ID (overridden by --agent)
 *   TOOL_SESSION_ID     — Default session ID (overridden by --session)
 */

const WebSocket = require('ws');

// ── Parse args ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { toolName: null, agentId: null, sessionId: null, input: {}, timeoutMs: null };

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  result.toolName = args[0];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--agent':
      case '-a':
        result.agentId = args[++i];
        break;
      case '--session':
      case '-s':
        result.sessionId = args[++i];
        break;
      case '--input':
      case '-i':
        try {
          const rawInput = args[++i];
          result.input = parseJsonInput(rawInput);
        } catch (err) {
          console.error(`Error: Invalid JSON for --input: ${err.message}`);
          process.exit(1);
        }
        break;
      case '--timeout':
      case '-t':
        result.timeoutMs = parseInt(args[++i], 10) * 1000; // seconds → ms
        break;
      default:
        // Try to parse as positional JSON (convenience: tool-cli.js service-status '{"action":"list"}')
        if (args[i].startsWith('{')) {
          try {
            result.input = JSON.parse(args[i]);
          } catch {
            console.error(`Error: Unrecognized argument: ${args[i]}`);
            process.exit(1);
          }
        } else {
          console.error(`Error: Unrecognized argument: ${args[i]}`);
          process.exit(1);
        }
    }
  }

  // Defaults from environment
  result.agentId = result.agentId || process.env.TOOL_AGENT_ID || null;
  result.sessionId = result.sessionId || process.env.TOOL_SESSION_ID || null;

  return result;
}

/**
 * Parse JSON passed on CLI and attempt a minimal repair for malformed
 * backslash escapes that can appear in LLM-generated shell commands.
 */
function parseJsonInput(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Repair lone backslashes not followed by a valid JSON escape token.
    // Example: "...\\_..." should be "...\\\\_..." in JSON.
    const repaired = String(raw).replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    if (repaired !== raw) {
      return JSON.parse(repaired);
    }
    throw err;
  }
}

function printUsage() {
  console.error(`Usage: node tool-cli.js <toolName> [--agent <id>] [--session <id>] [--input '<json>']`);
  console.error(`       node tool-cli.js list [--agent <id>]`);
}

// ── WebSocket helpers ───────────────────────────────────────────────────────

function connect(port, token, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.on('open', () => {
      // Authenticate
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth.ok') {
        clearTimeout(timer);
        resolve(ws);
      } else if (msg.type === 'auth.error') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`Auth failed: ${msg.error}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`Connection closed: ${code} ${reason}`));
    });
  });
}

function sendAndWait(ws, message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const reqId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    message.reqId = reqId;

    const timer = setTimeout(() => {
      reject(new Error(`Request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.reqId === reqId) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify(message));
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { toolName, agentId, sessionId, input, timeoutMs: customTimeout } = parseArgs(process.argv);

  // Tools that wait for human input get a longer default timeout
  const INTERACTIVE_TOOLS = ['ask-user'];
  const defaultTimeout = INTERACTIVE_TOOLS.includes(toolName) ? 6 * 60 * 1000 : 30000;
  const requestTimeout = customTimeout || defaultTimeout;

  const port = parseInt(process.env.CLAUDE_SOCKET_PORT, 10) || 3101;
  const token = process.env.CLAUDE_SOCKET_TOKEN;

  if (!token) {
    console.error('Error: CLAUDE_SOCKET_TOKEN environment variable is required');
    process.exit(1);
  }

  let ws;
  try {
    ws = await connect(port, token);
  } catch (err) {
    console.error(`Error: Could not connect to server — ${err.message}`);
    console.error('Make sure the server is running on port ' + port);
    process.exit(1);
  }

  try {
    // ── List tools ────────────────────────────────────────────────────────
    if (toolName === 'list') {
      const resp = await sendAndWait(ws, {
        type: 'agent.tools.list',
        agentId: agentId || '__global__',
      });

      if (resp.type === 'agent.tools.list.error') {
        console.error(`Error: ${resp.error}`);
        process.exit(1);
      }

      const tools = resp.tools || [];
      if (tools.length === 0) {
        console.log('No tools available.');
      } else {
        for (const tool of tools) {
          console.log(`\n${tool.name}`);
          if (tool.description) console.log(`  ${tool.description}`);
          if (tool.schema && tool.schema.properties) {
            const props = Object.entries(tool.schema.properties);
            if (props.length > 0) {
              console.log('  Parameters:');
              for (const [key, val] of props) {
                const req = (tool.schema.required || []).includes(key) ? ' (required)' : '';
                const desc = val.description ? ` — ${val.description}` : '';
                const enumVals = val.enum ? ` [${val.enum.join('|')}]` : '';
                console.log(`    ${key}: ${val.type || 'any'}${enumVals}${req}${desc}`);
              }
            }
          }
        }
      }
      process.exit(0);
    }

    // ── Execute tool ──────────────────────────────────────────────────────
    if (!agentId) {
      console.error('Error: --agent is required for tool execution');
      printUsage();
      process.exit(1);
    }

    const resp = await sendAndWait(ws, {
      type: 'agent.tool.execute',
      agentId,
      toolName,
      input,
      sessionId,
    }, requestTimeout);

    if (resp.type === 'agent.tool.error') {
      console.error(`Error: ${resp.error}`);
      process.exit(1);
    }

    const result = resp.result;
    if (result && result.isError) {
      console.error(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2));
      process.exit(1);
    }

    // Print output — string or JSON
    const output = result && result.output;
    if (typeof output === 'string') {
      console.log(output);
    } else if (output !== undefined && output !== null) {
      console.log(JSON.stringify(output, null, 2));
    }

  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
