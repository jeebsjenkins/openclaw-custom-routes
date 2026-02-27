#!/usr/bin/env node
/**
 * test-slack.js — Standalone Slack connection test.
 *
 * Tests:
 *   1. Bot token auth (auth.test)
 *   2. Bulk user cache load
 *   3. Bulk channel cache load
 *   4. Find user by name
 *   5. Open DM channel
 *   6. Send a test message
 *
 * Usage:
 *   node tests/test-slack.js
 *   node tests/test-slack.js --dm "Nathan Brown" --message "Hello from the test harness!"
 */

require('dotenv').config();
const { WebClient } = require('@slack/web-api');

const botToken = process.env.SLACK_BOT_TOKEN;
if (!botToken) {
  console.error('SLACK_BOT_TOKEN not set in .env');
  process.exit(1);
}

const web = new WebClient(botToken);

// ─── Caches ───────────────────────────────────────────────────────────────────

const usersById = new Map();
const usersByName = new Map(); // lowercase name → userId
const channelsById = new Map();
const channelsByName = new Map(); // lowercase name → channelId

// ─── Loaders ──────────────────────────────────────────────────────────────────

async function loadUsers() {
  let cursor;
  let count = 0;
  do {
    const res = await web.users.list({ limit: 200, cursor });
    for (const u of res.members || []) {
      const displayName = u.profile?.display_name || u.real_name || u.name || u.id;
      const entry = {
        id: u.id,
        name: u.name,
        realName: u.real_name || '',
        displayName,
        isBot: u.is_bot || false,
        deleted: u.deleted || false,
      };
      usersById.set(u.id, entry);
      // Index by all name variants (lowercase)
      if (displayName) usersByName.set(displayName.toLowerCase(), u.id);
      if (u.real_name) usersByName.set(u.real_name.toLowerCase(), u.id);
      if (u.name) usersByName.set(u.name.toLowerCase(), u.id);
      count++;
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return count;
}

async function loadChannels() {
  let cursor;
  let count = 0;
  do {
    const res = await web.conversations.list({
      limit: 200,
      cursor,
      types: 'public_channel,private_channel,mpim,im',
    });
    for (const ch of res.channels || []) {
      const entry = {
        id: ch.id,
        name: ch.name || ch.id,
        isIm: ch.is_im || false,
        userId: ch.user || null,
      };
      channelsById.set(ch.id, entry);
      if (ch.name) channelsByName.set(ch.name.toLowerCase(), ch.id);
      count++;
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return count;
}

function findUserByName(name) {
  const key = name.toLowerCase().replace(/^@/, '');
  const userId = usersByName.get(key);
  return userId ? usersById.get(userId) : null;
}

async function openDM(userId) {
  // Check cache for existing IM
  for (const [, ch] of channelsById) {
    if (ch.isIm && ch.userId === userId) return ch.id;
  }
  const res = await web.conversations.open({ users: userId });
  return res.channel.id;
}

// ─── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let dmTarget = 'Nathan Brown';
let messageText = 'Hello from the Jarvis test harness! This is a connectivity test.';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dm' && args[i + 1]) dmTarget = args[++i];
  if (args[i] === '--message' && args[i + 1]) messageText = args[++i];
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Slack Connection Test');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Auth test
  console.log('1. Testing bot token auth...');
  try {
    const auth = await web.auth.test();
    console.log(`   ✓ Authenticated as: ${auth.user} (${auth.user_id})`);
    console.log(`   ✓ Team: ${auth.team} (${auth.team_id})`);
    console.log(`   ✓ URL: ${auth.url}`);
  } catch (err) {
    console.error(`   ✗ Auth failed: ${err.message}`);
    process.exit(1);
  }

  // 2. Load users
  console.log('\n2. Loading user cache...');
  const userCount = await loadUsers();
  console.log(`   ✓ Cached ${userCount} users (${usersByName.size} name variants)`);

  // 3. Load channels
  console.log('\n3. Loading channel cache...');
  const channelCount = await loadChannels();
  console.log(`   ✓ Cached ${channelCount} channels`);

  // Show some stats
  const activeUsers = [...usersById.values()].filter(u => !u.deleted && !u.isBot);
  const imChannels = [...channelsById.values()].filter(c => c.isIm);
  const pubChannels = [...channelsById.values()].filter(c => !c.isIm);
  console.log(`   ✓ Active human users: ${activeUsers.length}`);
  console.log(`   ✓ IM channels: ${imChannels.length}, other channels: ${pubChannels.length}`);

  // 4. Find target user
  console.log(`\n4. Finding user "${dmTarget}"...`);
  const targetUser = findUserByName(dmTarget);
  if (!targetUser) {
    console.error(`   ✗ User "${dmTarget}" not found in cache`);
    console.log('\n   Available users (first 20):');
    const sample = activeUsers.slice(0, 20);
    for (const u of sample) {
      console.log(`     - ${u.displayName} (${u.realName}) [${u.id}]`);
    }
    process.exit(1);
  }
  console.log(`   ✓ Found: ${targetUser.displayName} (${targetUser.realName}) [${targetUser.id}]`);

  // 5. Open DM channel
  console.log('\n5. Opening DM channel...');
  const dmChannelId = await openDM(targetUser.id);
  console.log(`   ✓ DM channel: ${dmChannelId}`);

  // 6. Send message
  console.log(`\n6. Sending DM to ${targetUser.displayName}...`);
  console.log(`   Message: "${messageText}"`);
  try {
    const result = await web.chat.postMessage({
      channel: dmChannelId,
      text: messageText,
    });
    console.log(`   ✓ Message sent! ts: ${result.ts}`);
  } catch (err) {
    console.error(`   ✗ Failed to send: ${err.message}`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  All tests passed!');
  console.log('═══════════════════════════════════════════════════');
}

run().catch(err => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
