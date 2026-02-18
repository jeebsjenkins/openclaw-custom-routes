const gateway = require('./gateway');

/**
 * Send a Slack message through the OpenClaw gateway.
 * @param {Object} options
 * @param {string} options.target - Slack channel (e.g. '#mobey')
 * @param {string} options.message - The message text to send
 * @param {string} [options.replyTo] - Thread timestamp to reply to (e.g. '1234567890.123456')
 * @returns {Promise<Object>} The result from the gateway
 */
async function sendSlackMessage({ target, message, replyTo }) {
  const id = gateway.generateId();

  const params = {
    channel: 'slack',
    to: target,
    message,
    idempotencyKey: id,
  };

  if (replyTo) {
    params.replyTo = replyTo;
  }

  const payload = {
    id,
    type: 'req',
    method: 'send',
    params,
  };

  return gateway.send(payload);
}

module.exports = {
  sendSlackMessage,
};
