const { WebClient } = require('@slack/web-api');
const config = require('../config');

const slack = new WebClient(config.mobeySlackBotToken);

/**
 * Send a Slack message via the Slack Web API.
 * @param {Object} options
 * @param {string} options.channel - Slack channel (e.g. '#mobey' or channel ID)
 * @param {string} options.message - The message text to send
 * @param {string} [options.threadTs] - Thread timestamp for replying in a thread
 * @returns {Promise<Object>} The Slack API response
 */
async function sendSlackMessage({ channel, message, threadTs }) {
  const params = {
    channel,
    text: message,
  };

  if (threadTs) {
    params.thread_ts = threadTs;
  }

  return slack.chat.postMessage(params);
}

/**
 * Update an existing Slack message.
 * @param {Object} options
 * @param {string} options.channel - Slack channel ID
 * @param {string} options.ts - Timestamp of the message to update
 * @param {string} options.message - The new message text
 * @returns {Promise<Object>} The Slack API response
 */
async function updateSlackMessage({ channel, ts, message }) {
  return slack.chat.update({
    channel,
    ts,
    text: message,
  });
}

let userCache = null;

async function loadUsers() {
  const members = [];
  let cursor;
  do {
    const result = await slack.users.list({ limit: 200, cursor });
    members.push(...result.members);
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);
  userCache = members;
}

/**
 * Get Slack user info by username (display_name or real_name).
 * @param {string} username - Slack username / sender name to search for
 * @param {boolean} [refreshCache=false] - Force refresh the user cache
 * @returns {Promise<Object|null>} The matching user object, or null if not found
 */
async function getUserInfo(username, refreshCache = false) {
  if (!userCache || refreshCache) {
    await loadUsers();
  }
  const needle = username.toLowerCase();
  return userCache.find(m =>
    m.name?.toLowerCase() === needle ||
    m.profile?.display_name?.toLowerCase() === needle ||
    m.real_name?.toLowerCase() === needle
  ) || null;
}

async function uploadSlackFile({ channel, content, filename, title, threadTs }) {
  return slack.files.uploadV2({
    channel_id: channel,
    content,
    filename: filename || 'response.md',
    title: title || 'Response',
    // thread_ts: threadTs,
  });
}

function mdToSlack(md) {
  return md
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')  // single * → _italic_
    .replace(/`{3}(\w*)\n([\s\S]*?)`{3}/g, '```$2```')        // fenced code blocks (drop lang)
    .replace(/!\[.*?\]\(.*?\)/g, '')                            // strip images
    .replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>');                // links
}

module.exports = {
  sendSlackMessage,
  updateSlackMessage,
  uploadSlackFile,
  getUserInfo,
  mdToSlack,
};
