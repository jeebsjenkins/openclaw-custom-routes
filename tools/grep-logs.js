/**
 * grep-logs — Built-in tool for searching conversation logs across agents.
 *
 * Wraps the logScanner module. Available to all agents via PROJECT_ROOT/tools/.
 */

module.exports = {
  name: 'grep-logs',
  description: 'Search conversation logs across agents using regex or text patterns. Supports filtering by agent prefix, role, type, and time range.',

  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regex pattern to search for' },
      agentPrefix: { type: 'string', description: 'Only search agents matching this path prefix (e.g. "researcher")' },
      agentId: { type: 'string', description: 'Search a specific agent only' },
      role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'Filter by message role' },
      type: { type: 'string', description: 'Filter by entry type (e.g. "prompt", "result", "error")' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
    required: ['query'],
  },

  async execute(input, context) {
    const { logScanner } = context;
    if (!logScanner) {
      return { output: 'logScanner not available in context', isError: true };
    }

    try {
      const results = logScanner.search({
        query: input.query,
        agentPrefix: input.agentPrefix,
        agentId: input.agentId,
        role: input.role,
        type: input.type,
        limit: input.limit || 50,
      });

      if (results.length === 0) {
        return { output: `No matches found for "${input.query}"`, isError: false };
      }

      // Format results for readability
      const formatted = results.map(r => ({
        agent: r.agentId,
        session: r.sessionId,
        line: r.lineNumber,
        role: r.entry.role,
        type: r.entry.type,
        text: (r.entry.text || '').slice(0, 200),
        timestamp: r.entry.timestamp,
      }));

      return { output: formatted, isError: false };
    } catch (err) {
      return { output: err.message, isError: true };
    }
  },
};
