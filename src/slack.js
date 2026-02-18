const { WebClient } = require('@slack/web-api');

/**
 * Slack utility for posting messages back to Slack from custom routes.
 * 
 * Usage:
 * const slack = require('../src/slack');
 * 
 * // In your route handler:
 * const { slackToken, slackChannel, slackThreadTs } = req.body.slackContext;
 * await slack.postMessage({
 *   token: slackToken,
 *   channel: slackChannel,
 *   thread_ts: slackThreadTs,
 *   text: 'Processing complete!'
 * });
 */

/**
 * Post a message to Slack
 * @param {Object} options
 * @param {string} options.token - Slack bot token (xoxb-...)
 * @param {string} options.channel - Channel ID (C...)
 * @param {string} options.text - Message text (markdown supported)
 * @param {string} [options.thread_ts] - Thread timestamp (for replies)
 * @param {Array} [options.blocks] - Slack Block Kit blocks
 * @param {Array} [options.attachments] - Message attachments
 * @param {boolean} [options.mrkdwn=true] - Enable markdown formatting
 * @returns {Promise<Object>} Slack API response
 */
async function postMessage(options) {
  const {
    token,
    channel,
    text,
    thread_ts,
    blocks,
    attachments,
    mrkdwn = true,
  } = options;

  if (!token) {
    throw new Error('Slack token is required');
  }
  if (!channel) {
    throw new Error('Slack channel is required');
  }
  if (!text && !blocks) {
    throw new Error('Either text or blocks is required');
  }

  const client = new WebClient(token);

  const payload = {
    channel,
    text,
    mrkdwn,
  };

  if (thread_ts) {
    payload.thread_ts = thread_ts;
  }
  if (blocks) {
    payload.blocks = blocks;
  }
  if (attachments) {
    payload.attachments = attachments;
  }

  return await client.chat.postMessage(payload);
}

/**
 * Update an existing message
 * @param {Object} options
 * @param {string} options.token - Slack bot token
 * @param {string} options.channel - Channel ID
 * @param {string} options.ts - Message timestamp to update
 * @param {string} options.text - New message text
 * @param {Array} [options.blocks] - New blocks
 * @returns {Promise<Object>} Slack API response
 */
async function updateMessage(options) {
  const { token, channel, ts, text, blocks } = options;

  if (!token || !channel || !ts) {
    throw new Error('token, channel, and ts are required');
  }

  const client = new WebClient(token);

  const payload = {
    channel,
    ts,
    text,
  };

  if (blocks) {
    payload.blocks = blocks;
  }

  return await client.chat.update(payload);
}

/**
 * Add a reaction emoji to a message
 * @param {Object} options
 * @param {string} options.token - Slack bot token
 * @param {string} options.channel - Channel ID
 * @param {string} options.timestamp - Message timestamp
 * @param {string} options.name - Emoji name (without colons, e.g. 'thumbsup')
 * @returns {Promise<Object>} Slack API response
 */
async function addReaction(options) {
  const { token, channel, timestamp, name } = options;

  if (!token || !channel || !timestamp || !name) {
    throw new Error('token, channel, timestamp, and name are required');
  }

  const client = new WebClient(token);

  return await client.reactions.add({
    channel,
    timestamp,
    name,
  });
}

module.exports = {
  postMessage,
  updateMessage,
  addReaction,
};
