/**
 * send-message — Built-in tool for unified messaging.
 *
 * Wraps the messageBroker module. Available to all agents via PROJECT_ROOT/tools/.
 * Supports both agent-to-agent and external path routing.
 *
 * Examples:
 *   { to: "researcher" }             → routes to agent/researcher
 *   { to: "agent/researcher" }       → routes to agent/researcher
 *   { to: "slack/workspace/#general" } → routes to Slack channel subscribers
 *   { to: "email/to@co.com/from@x.com" } → routes to email subscribers
 */

module.exports = {
  name: 'send-message',
  description: 'Send a message via the unified broker. Accepts agent IDs (e.g. "researcher") or full paths (e.g. "slack/workspace/#channel", "email/to@domain/from@domain"). Messages are persisted and delivered in real-time.',

  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Delivery path or agent ID (e.g. "researcher", "agent/researcher", "slack/workspace/#channel")' },
      command: { type: 'string', description: 'Action verb (e.g. "analyze", "generate", "notify")' },
      payload: { type: 'object', description: 'Arbitrary data to send with the message' },
      source: { type: 'string', description: 'Source type for external routing (e.g. "slack", "email", "webhook"). Defaults to "internal"' },
      externalId: { type: 'string', description: 'External system message ID (e.g. Slack thread_ts, email message-id)' },
    },
    required: ['to', 'command'],
  },

  async execute(input, context) {
    const { messageBroker, agentId, sessionId } = context;
    if (!messageBroker) {
      return { output: 'messageBroker not available in context', isError: true };
    }

    if (!input.to) {
      return { output: 'Delivery path (to) is required', isError: true };
    }

    try {
      // Auto-detect: if 'to' doesn't contain a known path prefix, treat as agent ID
      const knownPrefixes = ['agent/', 'slack/', 'email/', 'webhook/', 'custom/'];
      const isFullPath = knownPrefixes.some(p => input.to.startsWith(p)) || input.to.includes('/');
      const deliveryPath = isFullPath ? input.to : `agent/${input.to}`;

      // Build from address: agent/{id}/session/{sid} when session is known
      const fromAddr = sessionId ? `agent/${agentId}/session/${sessionId}` : (agentId || 'unknown');

      const result = messageBroker.route(fromAddr, deliveryPath, {
        command: input.command || 'message',
        payload: input.payload || {},
        source: input.source || 'internal',
        externalId: input.externalId || null,
      });

      return {
        output: {
          messageId: result.id,
          from: result.from,
          path: result.path,
          command: result.command,
          delivered: result.delivered,
          deliveredTo: result.deliveredTo,
          timestamp: result.timestamp,
        },
        isError: false,
      };
    } catch (err) {
      return { output: err.message, isError: true };
    }
  },
};
