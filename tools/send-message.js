/**
 * send-message — Built-in tool for inter-agent messaging.
 *
 * Wraps the messageBus module. Available to all agents via PROJECT_ROOT/tools/.
 */

module.exports = {
  name: 'send-message',
  description: 'Send a message to another agent. Messages are persisted and delivered in real-time if the recipient is connected.',

  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target agent ID (path-based, e.g. "researcher/analyzer") or "*" for broadcast' },
      command: { type: 'string', description: 'Action verb (e.g. "analyze", "generate", "notify")' },
      payload: { type: 'object', description: 'Arbitrary data to send with the message' },
    },
    required: ['to', 'command'],
  },

  async execute(input, context) {
    const { messageBus, agentId } = context;
    if (!messageBus) {
      return { output: 'messageBus not available in context', isError: true };
    }

    if (!input.to) {
      return { output: 'Target agent ID (to) is required', isError: true };
    }

    try {
      const msg = messageBus.send(agentId, input.to, {
        command: input.command || 'message',
        payload: input.payload || {},
      });

      return {
        output: {
          messageId: msg.id,
          from: msg.from,
          to: msg.to,
          command: msg.command,
          timestamp: msg.timestamp,
        },
        isError: false,
      };
    } catch (err) {
      return { output: err.message, isError: true };
    }
  },
};
