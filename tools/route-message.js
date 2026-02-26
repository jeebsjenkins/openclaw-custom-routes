/**
 * route-message — Built-in tool for routing external inbound messages.
 *
 * Wraps the commsRouter module. Available to all agents via PROJECT_ROOT/tools/.
 * Routes messages to agents based on path-based subscriptions.
 */

module.exports = {
  name: 'route-message',
  description: 'Route an external inbound message to subscribed agents based on path matching. Messages are delivered via the message bus to all agents whose subscription patterns match the given path.',

  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Communication path (e.g. "slack/workspace/#channel", "email/to@domain/from@domain")' },
      source: { type: 'string', description: 'Source integration type (e.g. "slack", "email", "webhook", "custom")' },
      externalId: { type: 'string', description: 'External system message ID (e.g. Slack thread_ts, email message-id)' },
      payload: { type: 'object', description: 'Message content (user, text, timestamp, attachments, etc.)' },
    },
    required: ['path', 'source', 'payload'],
  },

  async execute(input, context) {
    const { commsRouter } = context;
    if (!commsRouter) {
      return { output: 'commsRouter not available in context', isError: true };
    }

    if (!input.path) {
      return { output: 'path is required', isError: true };
    }
    if (!input.source) {
      return { output: 'source is required', isError: true };
    }

    try {
      const result = commsRouter.route({
        path: input.path,
        source: input.source,
        externalId: input.externalId || null,
        payload: input.payload || {},
      });

      return {
        output: {
          delivered: result.delivered,
          deliveredTo: result.deliveredTo,
          messageIds: result.messageIds,
          unmatched: result.unmatched,
        },
        isError: false,
      };
    } catch (err) {
      return { output: err.message, isError: true };
    }
  },
};
