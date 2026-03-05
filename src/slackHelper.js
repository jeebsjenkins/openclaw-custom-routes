const { WebClient } = require('@slack/web-api');
const config = require('../config');

const slack = new WebClient(config.mobeySlackBotToken);

// Channel name → ID cache (populated on first lookup)
const channelIdCache = new Map();

/**
 * Resolve a channel identifier to a Slack channel ID.
 * Accepts channel IDs (pass-through), #names, or bare names.
 * @param {string} channel - Channel ID, #name, or bare name
 * @returns {Promise<string>} Resolved channel ID
 */
async function resolveChannelId(channel) {
  if (!channel) return channel;

  // Already a channel ID (starts with C, D, or G)
  if (/^[CDG][A-Z0-9]+$/.test(channel)) return channel;

  const name = channel.replace(/^#/, '').toLowerCase();

  // Check cache
  if (channelIdCache.has(name)) return channelIdCache.get(name);

  // Look up via conversations.list (paginated)
  let cursor;
  try {
    do {
      const res = await slack.conversations.list({
        limit: 200,
        cursor,
        types: 'public_channel,private_channel',
      });
      for (const ch of res.channels || []) {
        if (ch.name) channelIdCache.set(ch.name.toLowerCase(), ch.id);
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (err) {
    console.error(`[slackHelper] Failed to list channels for resolution: ${err.message}`);
  }

  return channelIdCache.get(name) || channel; // fall back to original if not found
}

/**
 * Send a Slack message via the Slack Web API.
 * @param {Object} options
 * @param {string} options.channel - Slack channel (ID, #name, or bare name)
 * @param {string} options.message - The message text to send
 * @param {string} [options.threadTs] - Thread timestamp for replying in a thread
 * @returns {Promise<Object>} The Slack API response
 */
async function sendSlackMessage({ channel, message, threadTs }) {
  const resolvedChannel = await resolveChannelId(channel);
  const params = {
    channel: resolvedChannel,
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
  const resolvedChannel = await resolveChannelId(channel);
  return slack.chat.update({
    channel: resolvedChannel,
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

/**
 * Fetch message history for a Slack thread.
 * @param {Object} options
 * @param {string} options.channel - Slack channel ID
 * @param {string} options.threadTs - Parent message timestamp
 * @param {number} [options.limit=20] - Max messages to fetch
 * @returns {Promise<Array<{user: string, text: string, ts: string}>>}
 */
async function fetchThreadHistory({ channel, threadTs, limit = 20 }) {
  const resolvedChannel = await resolveChannelId(channel);
  const result = await slack.conversations.replies({
    channel: resolvedChannel,
    ts: threadTs,
    limit,
  });
  return (result.messages || []).map(m => ({
    user: m.user,
    text: m.text,
    ts: m.ts,
    files: (m.files || []).map(f => ({
      name: f.name,
      mimetype: f.mimetype,
      url: f.url_private_download || f.url_private,
      size: f.size,
    })),
  }));
}

/**
 * Find the most recent message from a user in a channel.
 * Returns the message's ts (usable as thread_ts) or null.
 * @param {Object} options
 * @param {string} options.channel - Slack channel ID
 * @param {string} options.userId - Slack user ID (U...)
 * @param {number} [options.limit=50] - How many recent messages to scan
 * @returns {Promise<string|null>} The message ts, or null if not found
 */
async function findRecentUserMessage({ channel, userId, limit = 10 }) {
  const resolvedChannel = await resolveChannelId(channel);
  const result = await slack.conversations.history({
    channel: resolvedChannel,
    limit,
  });
  const msg = (result.messages || []).find(m => m.user === userId);
  return msg?.ts || null;
}

async function uploadSlackFile({ channel, content, filename, title, threadTs }) {
  const resolvedChannel = await resolveChannelId(channel);
  const params = {
    channel_id: resolvedChannel,
    filename: filename || 'response.md',
    title: title || 'Response',
    thread_ts: threadTs,
  };
  // Use `file` for Buffers (binary formats like docx/pdf), `content` for strings
  if (Buffer.isBuffer(content)) {
    params.file = content;
  } else {
    params.content = content;
  }
  return slack.files.uploadV2(params);
}

/**
 * Download a file from Slack using the bot token for authentication.
 * @param {string} url - The url_private or url_private_download URL
 * @returns {Promise<Buffer>} The file contents as a Buffer
 */
async function downloadSlackFile(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${config.mobeySlackBotToken}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to download Slack file: ${resp.status} ${resp.statusText}`);
  }
  return Buffer.from(await resp.arrayBuffer());
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
  fetchThreadHistory,
  findRecentUserMessage,
  getUserInfo,
  mdToSlack,
  resolveChannelId,
  downloadSlackFile,
};
