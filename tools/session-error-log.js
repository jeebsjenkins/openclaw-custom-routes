/**
 * session-error-log — Query per-session error log entries.
 */

module.exports = {
  name: 'session-error-log',
  description: 'Read error log entries for the current agent, either scoped to one session or across all agent sessions.',
  timeoutMs: 30 * 1000,
  schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['session', 'agent'],
        description: 'Query scope. "session" reads one session log (default). "agent" reads all sessions for this agent.',
        default: 'session',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session id override. For scope=session, defaults to current tool execution session.',
      },
      limit: {
        type: 'number',
        description: 'Max entries to return (default 50, max 500).',
        default: 50,
      },
      contains: {
        type: 'string',
        description: 'Optional substring filter against error text/payload.',
      },
      sinceTimestamp: {
        type: 'number',
        description: 'Optional unix epoch milliseconds lower bound.',
      },
    },
  },

  async execute(input, context) {
    const { projectManager, agentId } = context;
    const scope = input?.scope || 'session';
    const sessionId = input?.sessionId || context?.sessionId;
    const limit = Math.max(1, Math.min(Number(input?.limit) || 50, 500));
    const contains = (input?.contains || '').toLowerCase();
    const since = Number(input?.sinceTimestamp) || 0;

    if (!projectManager) {
      return { output: 'projectManager not available in tool context.', isError: true };
    }
    if (!agentId) {
      return { output: 'agentId is missing from tool context.', isError: true };
    }
    if (scope !== 'session' && scope !== 'agent') {
      return { output: 'Invalid scope. Use "session" or "agent".', isError: true };
    }

    let entries = [];
    if (scope === 'agent') {
      const sessions = projectManager.listSessions(agentId) || [];
      for (const s of sessions) {
        const sid = s?.id;
        if (!sid) continue;
        const rows = projectManager.getSessionErrorLog(agentId, sid) || [];
        for (const row of rows) {
          entries.push({ sessionId: sid, ...row });
        }
      }
    } else {
      if (!sessionId) {
        return { output: 'No sessionId provided and no current session context available.', isError: true };
      }
      entries = (projectManager.getSessionErrorLog(agentId, sessionId) || []).map((row) => ({
        sessionId,
        ...row,
      }));
    }

    if (since > 0) {
      entries = entries.filter(e => Number(e.timestamp) >= since);
    }
    if (contains) {
      entries = entries.filter((e) => {
        const hay = JSON.stringify(e).toLowerCase();
        return hay.includes(contains);
      });
    }

    entries.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    const total = entries.length;
    const sliced = entries.slice(Math.max(0, total - limit));

    return {
      output: {
        agentId,
        scope,
        sessionId: scope === 'session' ? sessionId : null,
        total,
        returned: sliced.length,
        entries: sliced,
      },
      isError: false,
    };
  },
};
