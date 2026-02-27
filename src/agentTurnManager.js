/**
 * agentTurnManager.js — Automatic agent turn execution.
 *
 * Watches broker deliveries and triggers agent turns in response to
 * inbound messages. Two-stage process:
 *
 *   Stage 1 — Triage (lightweight, fast model like Haiku):
 *     "Given this agent's role and these inbound messages, should the
 *      agent run a turn?" → YES/NO
 *
 *   Stage 2 — Execution (full Claude CLI via agentCLIPool):
 *     Constructs a prompt with the inbound messages and runs a full
 *     agent turn with session context, tools, CLAUDE.md, etc.
 *
 * Debouncing:
 *   Messages are batched per session with a short debounce window.
 *   A burst of 15 Slack messages becomes one agent turn, not 15.
 *
 * Concurrency:
 *   Only one turn runs per session at a time. If messages arrive while
 *   a turn is active, they queue for the next turn after completion.
 *
 * Configuration (per-session in session .json):
 *   {
 *     "autoRun": true,           // enable automatic turns
 *     "triageModel": "haiku",    // model for stage 1
 *     "debounceMs": 3000,        // batch window in ms
 *     "maxBatchSize": 20         // flush immediately at this count
 *   }
 *
 * Or per-agent in jvAgent.json:
 *   {
 *     "autoRun": {
 *       "enabled": true,
 *       "triageModel": "haiku",
 *       "debounceMs": 3000,
 *       "maxBatchSize": 20
 *     }
 *   }
 *
 * Session config overrides agent config. If neither has autoRun, the
 * message is delivered but no turn is triggered (current behavior).
 */

const crypto = require('crypto');
const cron = require('node-cron');

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_TRIAGE_MODEL = 'haiku';
const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_TRIAGE_TIMEOUT_MS = 30000;     // 30s max for triage
const DEFAULT_EXECUTION_TIMEOUT_MS = 300000; // 5 min max for execution

/**
 * Create an AgentTurnManager.
 *
 * @param {object} opts
 * @param {object} opts.messageBroker   - MessageBroker instance (onRoute, receiveSession, etc.)
 * @param {object} opts.projectManager  - ProjectManager instance
 * @param {object} opts.agentCLIPool    - AgentCLIPool instance
 * @param {object} [opts.anthropicClient] - AnthropicClient for triage (from anthropicHelper)
 * @param {object} [opts.log]           - Logger
 * @param {object} [opts.defaults]      - Global defaults for triage/debounce
 * @returns {object} AgentTurnManager API
 */
function createAgentTurnManager(opts) {
  const {
    messageBroker,
    projectManager,
    agentCLIPool,
    anthropicClient = null,
    log = console,
    defaults = {},
  } = opts;

  if (!messageBroker) throw new Error('agentTurnManager: messageBroker is required');
  if (!projectManager) throw new Error('agentTurnManager: projectManager is required');
  if (!agentCLIPool) throw new Error('agentTurnManager: agentCLIPool is required');

  const globalDefaults = {
    triageModel: defaults.triageModel || DEFAULT_TRIAGE_MODEL,
    debounceMs: defaults.debounceMs || DEFAULT_DEBOUNCE_MS,
    maxBatchSize: defaults.maxBatchSize || DEFAULT_MAX_BATCH_SIZE,
    triageTimeoutMs: defaults.triageTimeoutMs || DEFAULT_TRIAGE_TIMEOUT_MS,
    executionTimeoutMs: defaults.executionTimeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS,
  };

  // Debounce queues: "agentId:sessionId" → { timer, messages[], config }
  const debounceQueues = new Map();

  // Active turns: "agentId:sessionId" → Promise (prevents concurrent runs)
  const activeTurns = new Map();

  // Pending re-runs: "agentId:sessionId" → messages[] (queued during active turn)
  const pendingRerun = new Map();

  // Heartbeat scheduled jobs: agentId → cron.ScheduledTask
  const heartbeatJobs = new Map();

  // Stats tracking
  const stats = {
    triageCount: 0,
    triageAccepted: 0,
    triageRejected: 0,
    triageErrors: 0,
    executionCount: 0,
    executionErrors: 0,
    messagesProcessed: 0,
  };

  // Hook into broker
  let unhookRoute = null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start watching broker deliveries and heartbeat schedules.
   */
  function start() {
    if (unhookRoute) return; // already started

    unhookRoute = messageBroker.onRoute((result) => {
      if (!result.delivered) return;

      // Handle session-level deliveries (specific sessions)
      for (const { agentId, sessionId } of result.deliveredToSessions) {
        _onSessionDelivery(agentId, sessionId, result);
      }

      // Handle agent-level deliveries to main session (when no session handled it)
      for (const agentId of result.deliveredTo) {
        // If a session already handled this for this agent, skip the main session
        const sessionHandled = result.deliveredToSessions.some(s => s.agentId === agentId);
        if (!sessionHandled) {
          _onSessionDelivery(agentId, 'main', result);
        }
      }
    });

    // Start heartbeat schedules for all agents
    _startHeartbeats();

    log.info('[agentTurnManager] Started — watching broker deliveries + heartbeats');
  }

  /**
   * Stop watching and drain all pending queues.
   */
  function stop() {
    if (unhookRoute) {
      unhookRoute();
      unhookRoute = null;
    }

    // Clear all debounce timers
    for (const [key, queue] of debounceQueues) {
      if (queue.timer) clearTimeout(queue.timer);
    }
    debounceQueues.clear();
    pendingRerun.clear();

    // Stop all heartbeat jobs
    _stopHeartbeats();

    log.info('[agentTurnManager] Stopped');
  }

  // ─── Heartbeat / CRON ─────────────────────────────────────────────────────

  /**
   * Scan all agents for heartbeat cron config and schedule jobs.
   */
  function _startHeartbeats() {
    let agents;
    try {
      agents = projectManager.listAgents();
    } catch (err) {
      log.warn(`[agentTurnManager] Could not list agents for heartbeat scan: ${err.message}`);
      return;
    }

    for (const agent of agents) {
      _scheduleHeartbeat(agent);
    }
  }

  /**
   * Schedule a heartbeat for a single agent (if configured).
   */
  function _scheduleHeartbeat(agent) {
    const agentId = agent.id || agent.name;
    const heartbeatCron = agent.heartbeat;

    if (!heartbeatCron || typeof heartbeatCron !== 'string') return;

    if (!cron.validate(heartbeatCron)) {
      log.warn(`[agentTurnManager] Invalid heartbeat cron for agent "${agentId}": ${heartbeatCron}`);
      return;
    }

    // Stop existing job if any
    if (heartbeatJobs.has(agentId)) {
      heartbeatJobs.get(agentId).stop();
    }

    const job = cron.schedule(heartbeatCron, () => {
      _fireHeartbeat(agentId, heartbeatCron);
    });

    heartbeatJobs.set(agentId, job);
    log.info(`[agentTurnManager] Scheduled heartbeat for "${agentId}": ${heartbeatCron}`);
  }

  /**
   * Fire a heartbeat turn for an agent by routing a synthetic message through the broker.
   */
  function _fireHeartbeat(agentId, cronExpr) {
    log.info(`[agentTurnManager] Heartbeat firing for "${agentId}"`);

    try {
      messageBroker.route('system/heartbeat', `agent/${agentId}`, {
        command: 'heartbeat',
        payload: {
          scheduled: true,
          cron: cronExpr,
          firedAt: new Date().toISOString(),
        },
        source: 'heartbeat',
      });
    } catch (err) {
      log.error(`[agentTurnManager] Heartbeat route failed for "${agentId}": ${err.message}`);
    }
  }

  /**
   * Stop all heartbeat jobs.
   */
  function _stopHeartbeats() {
    for (const [agentId, job] of heartbeatJobs) {
      job.stop();
      log.info(`[agentTurnManager] Stopped heartbeat for "${agentId}"`);
    }
    heartbeatJobs.clear();
  }

  /**
   * Re-scan agents and update heartbeat schedules.
   * Call this when agent configs change at runtime.
   */
  function refreshHeartbeats() {
    _stopHeartbeats();
    _startHeartbeats();
  }

  // ─── Delivery Handler ──────────────────────────────────────────────────────

  /**
   * Called when a message is delivered to a session (or to an agent's main session).
   * Checks autoRun config and enqueues if enabled.
   */
  function _onSessionDelivery(agentId, sessionId, routeResult) {
    const config = _resolveConfig(agentId, sessionId);
    if (!config.enabled) return;

    _enqueue(agentId, sessionId, routeResult, config);
  }

  /**
   * Resolve autoRun config for a session, falling back to agent, then global defaults.
   */
  function _resolveConfig(agentId, sessionId) {
    // Check session config first
    try {
      const session = projectManager.getSession(agentId, sessionId);
      if (session && session.autoRun !== undefined) {
        if (typeof session.autoRun === 'boolean') {
          return { enabled: session.autoRun, ...globalDefaults };
        }
        if (typeof session.autoRun === 'object') {
          return {
            enabled: session.autoRun.enabled !== false,
            triageModel: session.autoRun.triageModel || globalDefaults.triageModel,
            debounceMs: session.autoRun.debounceMs || globalDefaults.debounceMs,
            maxBatchSize: session.autoRun.maxBatchSize || globalDefaults.maxBatchSize,
            triageTimeoutMs: session.autoRun.triageTimeoutMs || globalDefaults.triageTimeoutMs,
            executionTimeoutMs: session.autoRun.executionTimeoutMs || globalDefaults.executionTimeoutMs,
          };
        }
      }
    } catch { /* session not found — fall through */ }

    // Check agent config
    try {
      const agent = projectManager.getAgent(agentId);
      if (agent && agent.autoRun !== undefined) {
        if (typeof agent.autoRun === 'boolean') {
          return { enabled: agent.autoRun, ...globalDefaults };
        }
        if (typeof agent.autoRun === 'object') {
          return {
            enabled: agent.autoRun.enabled !== false,
            triageModel: agent.autoRun.triageModel || globalDefaults.triageModel,
            debounceMs: agent.autoRun.debounceMs || globalDefaults.debounceMs,
            maxBatchSize: agent.autoRun.maxBatchSize || globalDefaults.maxBatchSize,
            triageTimeoutMs: agent.autoRun.triageTimeoutMs || globalDefaults.triageTimeoutMs,
            executionTimeoutMs: agent.autoRun.executionTimeoutMs || globalDefaults.executionTimeoutMs,
          };
        }
      }
    } catch { /* agent not found — fall through */ }

    // Default: disabled unless explicitly enabled
    return { enabled: false, ...globalDefaults };
  }

  // ─── Debounce Queue ────────────────────────────────────────────────────────

  function _enqueue(agentId, sessionId, routeResult, config) {
    const key = `${agentId}:${sessionId}`;

    // If a turn is already active, queue for re-run after it completes
    if (activeTurns.has(key)) {
      if (!pendingRerun.has(key)) pendingRerun.set(key, []);
      pendingRerun.get(key).push(routeResult);
      return;
    }

    if (!debounceQueues.has(key)) {
      debounceQueues.set(key, { timer: null, messages: [], config });
    }

    const queue = debounceQueues.get(key);
    queue.messages.push(routeResult);

    // Reset debounce timer
    if (queue.timer) clearTimeout(queue.timer);

    // Flush immediately if batch is full
    if (queue.messages.length >= config.maxBatchSize) {
      _flush(agentId, sessionId);
      return;
    }

    queue.timer = setTimeout(() => {
      _flush(agentId, sessionId);
    }, config.debounceMs);
  }

  async function _flush(agentId, sessionId) {
    const key = `${agentId}:${sessionId}`;
    const queue = debounceQueues.get(key);
    if (!queue || queue.messages.length === 0) return;

    const routeResults = [...queue.messages];
    const config = queue.config;

    // Clear queue
    queue.messages = [];
    if (queue.timer) clearTimeout(queue.timer);
    debounceQueues.delete(key);

    // Extract the actual message objects from route results
    const messages = routeResults.map(r => ({
      id: r.id,
      from: r.from,
      path: r.path,
      command: r.command,
      payload: r.payload,
      source: r.source,
      externalId: r.externalId,
      timestamp: r.timestamp,
    }));

    // Run the turn (with active turn tracking)
    const turnPromise = _runTurn(agentId, sessionId, messages, config);
    activeTurns.set(key, turnPromise);

    try {
      await turnPromise;
    } finally {
      activeTurns.delete(key);

      // Check for pending messages that arrived during the turn
      if (pendingRerun.has(key)) {
        const pending = pendingRerun.get(key);
        pendingRerun.delete(key);

        // Re-enqueue them (they'll go through debounce again)
        for (const routeResult of pending) {
          _enqueue(agentId, sessionId, routeResult, config);
        }
      }
    }
  }

  // ─── Turn Execution ────────────────────────────────────────────────────────

  async function _runTurn(agentId, sessionId, messages, config) {
    const turnId = crypto.randomUUID().slice(0, 8);

    log.info(`[agentTurnManager] Turn ${turnId}: ${agentId}:${sessionId} — ${messages.length} message(s)`);

    // Stage 1: Triage
    const shouldRun = await _triage(agentId, sessionId, messages, config, turnId);

    if (!shouldRun) {
      log.info(`[agentTurnManager] Turn ${turnId}: triage → SKIP`);
      return { turnId, skipped: true, reason: 'triage_rejected' };
    }

    // Stage 2: Execute
    log.info(`[agentTurnManager] Turn ${turnId}: triage → RUN`);
    const result = await _execute(agentId, sessionId, messages, config, turnId);

    stats.messagesProcessed += messages.length;
    return { turnId, ...result };
  }

  // ─── Stage 1: Triage ──────────────────────────────────────────────────────

  /**
   * Build the triage prompt from agent context and inbound messages.
   */
  function _buildTriagePrompt(agentId, sessionId, messages) {
    let agentDescription = '';
    try {
      const agent = projectManager.getAgent(agentId);
      agentDescription = agent.description || agent.name || agentId;
    } catch {
      agentDescription = agentId;
    }

    const messageSummary = messages.map((m, i) => {
      const parts = [`  ${i + 1}. [${m.source}] ${m.from} → ${m.path}: ${m.command}`];
      if (m.payload && Object.keys(m.payload).length > 0) {
        const payloadStr = JSON.stringify(m.payload);
        parts.push(`     Payload: ${payloadStr.length > 300 ? payloadStr.slice(0, 300) + '...' : payloadStr}`);
      }
      return parts.join('\n');
    }).join('\n');

    return [
      `You are a message triage system. Decide if this agent should run a turn.`,
      ``,
      `Agent: "${agentId}"`,
      `Role: ${agentDescription}`,
      `Session: ${sessionId}`,
      ``,
      `Inbound messages (${messages.length}):`,
      messageSummary,
      ``,
      `Should this agent process these messages? Consider:`,
      `- Does this match the agent's role/responsibilities?`,
      `- Is this actionable (not just noise/status)?`,
      `- Would the agent have something useful to do in response?`,
      ``,
      `Reply with exactly YES or NO on the first line, then a brief reason.`,
    ].join('\n');
  }

  /**
   * Triage via direct Anthropic API call (fast, lightweight).
   */
  async function _triageViaAPI(triagePrompt, config, turnId) {
    const result = await anthropicClient.message({
      model: config.triageModel,  // alias like 'haiku' resolved by anthropicClient
      maxTokens: 128,
      temperature: 0,
      messages: [{ role: 'user', content: triagePrompt }],
      timeoutMs: config.triageTimeoutMs,
    });

    return result.text || '';
  }

  /**
   * Triage via Claude CLI (fallback when no API key is configured).
   */
  async function _triageViaCLI(agentId, triagePrompt, config) {
    const cli = agentCLIPool.getAgentCLI(agentId);
    const result = await cli.query(triagePrompt, {
      model: config.triageModel,
      timeoutMs: config.triageTimeoutMs,
      noSessionPersistence: true,
    });

    return (result.markdown || result.text || '').trim();
  }

  async function _triage(agentId, sessionId, messages, config, turnId) {
    stats.triageCount++;

    const triagePrompt = _buildTriagePrompt(agentId, sessionId, messages);

    try {
      let text;

      if (anthropicClient) {
        text = await _triageViaAPI(triagePrompt, config, turnId);
      } else {
        text = await _triageViaCLI(agentId, triagePrompt, config);
      }

      const firstLine = text.split('\n')[0].toUpperCase();
      const accepted = firstLine.startsWith('YES');

      if (accepted) {
        stats.triageAccepted++;
      } else {
        stats.triageRejected++;
      }

      log.info(`[agentTurnManager] Turn ${turnId}: triage response: ${text.slice(0, 100)}`);
      return accepted;
    } catch (err) {
      stats.triageErrors++;
      log.error(`[agentTurnManager] Turn ${turnId}: triage error: ${err.message}`);
      // Default to running on triage failure — better to over-run than miss messages
      return true;
    }
  }

  // ─── Memory Assembly ─────────────────────────────────────────────────────

  /**
   * Assemble the three-tier memory context for a turn.
   * Passed to the CLI via --system-prompt so it's separate from the user prompt.
   */
  function _assembleMemoryContext(agentId, sessionId) {
    const parts = [];

    // System memory (project-wide)
    try {
      const systemMem = projectManager.getSystemMemory();
      if (systemMem.trim()) {
        parts.push(`=== SYSTEM CONTEXT ===\n${systemMem}`);
      }
    } catch { /* non-fatal */ }

    // Agent memory
    try {
      const agentMem = projectManager.getAgentMemory(agentId);
      if (agentMem.trim()) {
        parts.push(`=== AGENT MEMORY ===\n${agentMem}`);
      }
    } catch { /* non-fatal */ }

    // Session memory
    try {
      const sessionMem = projectManager.getSessionMemory(agentId, sessionId);
      if (sessionMem.trim()) {
        parts.push(`=== SESSION MEMORY ===\n${sessionMem}`);
      }
    } catch { /* non-fatal */ }

    return parts.length > 0 ? parts.join('\n\n') : '';
  }

  // ─── Stage 2: Execution ────────────────────────────────────────────────────

  async function _execute(agentId, sessionId, messages, config, turnId) {
    stats.executionCount++;

    // Build execution prompt with message context
    const messageBlocks = messages.map((m, i) => {
      const header = `--- Message ${i + 1} of ${messages.length} ---`;
      const meta = [
        `From: ${m.from}`,
        `Path: ${m.path}`,
        `Command: ${m.command}`,
      ];
      if (m.source !== 'internal') meta.push(`Source: ${m.source}`);
      if (m.externalId) meta.push(`External ID: ${m.externalId}`);

      let payload = '';
      if (m.payload && Object.keys(m.payload).length > 0) {
        payload = `\nPayload:\n${JSON.stringify(m.payload, null, 2)}`;
      }

      return `${header}\n${meta.join('\n')}${payload}`;
    }).join('\n\n');

    // Detect heartbeat-only turns for a tailored prompt
    const isHeartbeat = messages.length === 1 && messages[0].command === 'heartbeat' && messages[0].source === 'heartbeat';

    const prompt = isHeartbeat
      ? [
          `This is a scheduled heartbeat. You are being activated on a CRON schedule.`,
          ``,
          `Check your memory/notes.md for active tasks, review any pending items,`,
          `and take action as needed. If there's nothing to do, briefly note that`,
          `in your session memory and exit.`,
        ].join('\n')
      : [
          `You have ${messages.length} new inbound message(s) to process:`,
          ``,
          messageBlocks,
          ``,
          `Process these messages according to your role and instructions.`,
          `Use your available tools to take action as needed.`,
          `If a message requires a reply, use the send-message tool.`,
          `Update your memory/notes.md if you learn anything important.`,
        ].join('\n');

    try {
      const cli = agentCLIPool.getAgentCLI(agentId);

      // Assemble memory context for --system-prompt
      const memoryContext = _assembleMemoryContext(agentId, sessionId);

      const cliOptions = {
        resumeSessionId: sessionId,
        timeoutMs: config.executionTimeoutMs,
      };
      if (memoryContext) {
        cliOptions.systemPrompt = memoryContext;
      }

      // Include session directory as an additional dir
      try {
        const sessionDir = projectManager.getSessionDir(agentId, sessionId);
        cliOptions.additionalDirs = [sessionDir];

        // Also merge session-level workDirs if any
        const session = projectManager.getSession(agentId, sessionId);
        if (session && session.workDirs && session.workDirs.length > 0) {
          cliOptions.additionalDirs.push(...session.workDirs);
        }
      } catch { /* non-fatal */ }

      const result = await cli.query(prompt, cliOptions);

      const responseText = (result.markdown || result.text || '').trim();

      // Log the auto-turn to conversation history
      try {
        projectManager.appendConversationLog(agentId, sessionId, {
          role: 'system',
          type: 'auto-turn',
          turnId,
          messageCount: messages.length,
          messageIds: messages.map(m => m.id),
          timestamp: Date.now(),
        });
        projectManager.appendConversationLog(agentId, sessionId, {
          role: 'assistant',
          type: 'auto-turn-result',
          turnId,
          text: responseText,
          timestamp: Date.now(),
        });
      } catch (logErr) {
        log.warn(`[agentTurnManager] Turn ${turnId}: failed to log conversation: ${logErr.message}`);
      }

      log.info(`[agentTurnManager] Turn ${turnId}: executed — ${responseText.length} chars response`);
      return { executed: true, messageCount: messages.length, responseLength: responseText.length };
    } catch (err) {
      stats.executionErrors++;

      // Log the error
      try {
        projectManager.appendConversationLog(agentId, sessionId, {
          role: 'system',
          type: 'auto-turn-error',
          turnId,
          error: err.message,
          timestamp: Date.now(),
        });
      } catch { /* non-fatal */ }

      log.error(`[agentTurnManager] Turn ${turnId}: execution error: ${err.message}`);
      return { executed: false, error: err.message };
    }
  }

  // ─── Manual Trigger ────────────────────────────────────────────────────────

  /**
   * Manually trigger a turn for a session with specific messages.
   * Bypasses triage (goes straight to execution).
   */
  async function triggerTurn(agentId, sessionId, messages) {
    const config = _resolveConfig(agentId, sessionId);
    // Override enabled check for manual triggers
    const turnId = crypto.randomUUID().slice(0, 8);
    log.info(`[agentTurnManager] Manual turn ${turnId}: ${agentId}:${sessionId}`);
    return _execute(agentId, sessionId, messages, { ...config, ...globalDefaults }, turnId);
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  function getStats() {
    return {
      ...stats,
      activeTurns: activeTurns.size,
      queuedSessions: debounceQueues.size,
      pendingReruns: pendingRerun.size,
    };
  }

  function isActive(agentId, sessionId) {
    return activeTurns.has(`${agentId}:${sessionId}`);
  }

  return {
    start,
    stop,
    triggerTurn,
    refreshHeartbeats,
    getStats,
    isActive,

    // Exposed for testing
    _resolveConfig,
    _flush,
  };
}

module.exports = { createAgentTurnManager };
