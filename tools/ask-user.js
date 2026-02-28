/**
 * ask-user — Ask the human operator a question and wait for their response.
 *
 * This tool bridges the agent ↔ dashboard gap. When an agent needs human input
 * (clarification, approval, choices), it calls this tool. The question is pushed
 * to connected dashboard clients via WebSocket. The tool blocks until the user
 * responds or the timeout expires.
 *
 * The `askUser` function is injected into the tool context by claudeSocket.js.
 */

module.exports = {
  name: 'ask-user',
  description: 'Ask the user a question and wait for their response. Use this when you need clarification, approval, or a choice from the human operator. The question will appear as an interactive prompt in the dashboard.',

  schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of choices. If provided, the user picks from these. If omitted, the user can type a free-form response.',
      },
      context: {
        type: 'string',
        description: 'Optional context or explanation to show alongside the question',
      },
    },
    required: ['question'],
  },

  async execute(input, context) {
    const { askUser } = context;

    if (typeof askUser !== 'function') {
      return {
        output: 'askUser is not available in the tool context. This tool only works when called through a dashboard-connected session.',
        isError: true,
      };
    }

    try {
      const answer = await askUser({
        question: input.question,
        options: input.options || null,
        context: input.context || null,
      });

      return {
        output: typeof answer === 'string' ? answer : JSON.stringify(answer),
        isError: false,
      };
    } catch (err) {
      return {
        output: `Failed to get user response: ${err.message}`,
        isError: true,
      };
    }
  },
};
