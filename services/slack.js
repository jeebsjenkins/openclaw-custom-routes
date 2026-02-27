/**
 * slack.js — Slack Socket Mode service.
 *
 * Connects to Slack via Socket Mode (WebSocket) using an app-level token,
 * routes inbound messages into the broker, and listens for outbound messages
 * from agents to send back to Slack.
 *
 * Caching:
 *   Users and channels are bulk-loaded on connect and cached in memory.
 *   If a lookup misses the cache, a single-item API call is made and the
 *   result is inserted into the cache. A full cache reload can be triggered
 *   by calling reloadCaches() or happens automatically every CACHE_TTL_MS.
 *
 * Env vars:
 *   SLACK_APP_TOKEN   — App-level token (xapp-...) for Socket Mode
 *   SLACK_BOT_TOKEN   — Bot user OAuth token (xoxb-...) for Web API calls
 *   SLACK_WORKSPACE   — Workspace identifier for broker paths (default: "default")
 *
 * Broker paths:
 *   Inbound:   slack/{workspace}/#{channel}   — channel messages
 *              slack/{workspace}/@{user}       — DMs
 *   Outbound:  Agents route messages to slack/{workspace}/#{channel} with
 *              command: "slack.send" and payload: { channel, text, thread_ts? }
 */

const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

module.exports = {
  name: 'slack',
  description: 'Slack Socket Mode — bidirectional message bridge',

  start(context) {
    const { messageBroker, log } = context;

    const appToken = process.env.SLACK_APP_TOKEN;
    const botToken = process.env.SLACK_BOT_TOKEN;
    const workspace = process.env.SLACK_WORKSPACE || 'default';

    if (!appToken) {
      log.warn('[slack-service] SLACK_APP_TOKEN not set — service disabled');
      return;
    }
    if (!botToken) {
      log.warn('[slack-service] SLACK_BOT_TOKEN not set — service disabled');
      return;
    }

    // ─── Clients ──────────────────────────────────────────────────────────

    const socketClient = new SocketModeClient({ appToken });
    const webClient = new WebClient(botToken);

    // Our own bot user ID — populated on connect
    let botUserId = null;

    // ─── Caches ───────────────────────────────────────────────────────────

    // userId → { id, name, realName, displayName }
    const usersById = new Map();
    // lowercase display/real name → userId  (for reverse lookup by name)
    const usersByName = new Map();

    // channelId → { id, name, isIm, isDm }
    const channelsById = new Map();
    // lowercase channel name → channelId
    const channelsByName = new Map();

    let cacheLoadedAt = 0;

    /**
     * Bulk-load all users into cache via paginated users.list.
     */
    async function loadUsers() {
      let cursor;
      let count = 0;
      try {
        do {
          const res = await webClient.users.list({ limit: 200, cursor });
          for (const u of res.members || []) {
            if (u.deleted || u.is_bot) continue;
            const displayName = u.profile.display_name || u.real_name || u.name || u.id;
            const entry = {
              id: u.id,
              name: u.name,
              realName: u.real_name || '',
              displayName,
            };
            usersById.set(u.id, entry);
            usersByName.set(displayName.toLowerCase(), u.id);
            if (u.real_name) usersByName.set(u.real_name.toLowerCase(), u.id);
            if (u.name) usersByName.set(u.name.toLowerCase(), u.id);
            count++;
          }
          cursor = res.response_metadata?.next_cursor;
        } while (cursor);
        log.info(`[slack-service] Cached ${count} users`);
      } catch (err) {
        log.error(`[slack-service] Failed to load users: ${err.message}`);
      }
    }

    /**
     * Bulk-load all conversations (channels, DMs, groups) into cache.
     */
    async function loadChannels() {
      let cursor;
      let count = 0;
      try {
        do {
          const res = await webClient.conversations.list({
            limit: 200,
            cursor,
            types: 'public_channel,private_channel,mpim,im',
          });
          for (const ch of res.channels || []) {
            const entry = {
              id: ch.id,
              name: ch.name || ch.id,
              isIm: ch.is_im || false,
              userId: ch.user || null, // for IMs, the other user's ID
            };
            channelsById.set(ch.id, entry);
            if (ch.name) channelsByName.set(ch.name.toLowerCase(), ch.id);
            count++;
          }
          cursor = res.response_metadata?.next_cursor;
        } while (cursor);
        log.info(`[slack-service] Cached ${count} channels`);
      } catch (err) {
        log.error(`[slack-service] Failed to load channels: ${err.message}`);
      }
    }

    /**
     * Load both caches. Called on connect and periodically.
     */
    async function reloadCaches() {
      await Promise.all([loadUsers(), loadChannels()]);
      cacheLoadedAt = Date.now();
    }

    // ─── Lookup helpers (cache-first, single-fetch fallback) ──────────────

    async function resolveUser(userId) {
      if (usersById.has(userId)) return usersById.get(userId);

      // Cache miss — fetch single user and insert
      try {
        const info = await webClient.users.info({ user: userId });
        const u = info.user;
        const displayName = u.profile.display_name || u.real_name || u.name || u.id;
        const entry = { id: u.id, name: u.name, realName: u.real_name || '', displayName };
        usersById.set(u.id, entry);
        usersByName.set(displayName.toLowerCase(), u.id);
        if (u.real_name) usersByName.set(u.real_name.toLowerCase(), u.id);
        if (u.name) usersByName.set(u.name.toLowerCase(), u.id);
        log.info(`[slack-service] Cache miss — fetched user ${displayName} (${u.id})`);
        return entry;
      } catch (err) {
        log.warn(`[slack-service] Failed to resolve user ${userId}: ${err.message}`);
        return { id: userId, name: userId, realName: '', displayName: userId };
      }
    }

    async function resolveChannel(channelId) {
      if (channelsById.has(channelId)) return channelsById.get(channelId);

      // Cache miss — fetch single channel and insert
      try {
        const info = await webClient.conversations.info({ channel: channelId });
        const ch = info.channel;
        const entry = {
          id: ch.id,
          name: ch.name || ch.id,
          isIm: ch.is_im || false,
          userId: ch.user || null,
        };
        channelsById.set(ch.id, entry);
        if (ch.name) channelsByName.set(ch.name.toLowerCase(), ch.id);
        log.info(`[slack-service] Cache miss — fetched channel ${entry.name} (${ch.id})`);
        return entry;
      } catch (err) {
        log.warn(`[slack-service] Failed to resolve channel ${channelId}: ${err.message}`);
        return { id: channelId, name: channelId, isIm: false, userId: null };
      }
    }

    /**
     * Find a user by display name, real name, or Slack username.
     * Returns { id, name, realName, displayName } or null.
     */
    function findUserByName(name) {
      const key = name.toLowerCase().replace(/^@/, '');
      const userId = usersByName.get(key);
      return userId ? usersById.get(userId) : null;
    }

    /**
     * Find a channel by name (without #).
     * Returns channelId or null.
     */
    function findChannelByName(name) {
      const key = name.toLowerCase().replace(/^#/, '');
      return channelsByName.get(key) || null;
    }

    /**
     * Open or find the DM channel with a user.
     */
    async function openDM(userId) {
      // Check cache first — look for an IM channel with this user
      for (const [, ch] of channelsById) {
        if (ch.isIm && ch.userId === userId) return ch.id;
      }
      // Not cached — open it via API
      try {
        const res = await webClient.conversations.open({ users: userId });
        const ch = res.channel;
        channelsById.set(ch.id, { id: ch.id, name: ch.id, isIm: true, userId });
        return ch.id;
      } catch (err) {
        log.error(`[slack-service] Failed to open DM with ${userId}: ${err.message}`);
        return null;
      }
    }

    // ─── Inbound: Slack → Broker ──────────────────────────────────────────

    socketClient.on('message', async ({ event, ack }) => {
      await ack();

      // Ignore bot's own messages to prevent loops
      if (event.bot_id || event.user === botUserId) return;

      // Ignore message subtypes we don't care about (edits, deletes, joins, etc.)
      if (event.subtype && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return;

      const channelId = event.channel;
      const userId = event.user;
      const text = event.text || '';
      const threadTs = event.thread_ts || null;

      // Resolve names from cache
      const [user, channel] = await Promise.all([
        resolveUser(userId),
        resolveChannel(channelId),
      ]);

      const isDM = event.channel_type === 'im' || channel.isIm;
      const brokerPath = isDM
        ? `slack/${workspace}/@${user.displayName}`
        : `slack/${workspace}/#${channel.name}`;

      log.info(`[slack-service] Inbound: ${user.displayName} in ${isDM ? 'DM' : `#${channel.name}`}: ${text.slice(0, 80)}`);

      try {
        messageBroker.route(`slack/${workspace}/${user.displayName}`, brokerPath, {
          command: 'slack.message',
          payload: {
            text,
            channelId,
            channelName: channel.name,
            userId,
            userName: user.displayName,
            threadTs,
            isDM,
            ts: event.ts,
            files: (event.files || []).map(f => ({
              name: f.name,
              mimetype: f.mimetype,
              url: f.url_private,
              size: f.size,
            })),
          },
          source: 'slack',
          externalId: event.ts,
        });
      } catch (err) {
        log.error(`[slack-service] Failed to route inbound message: ${err.message}`);
      }
    });

    // ─── Reactions ────────────────────────────────────────────────────────

    socketClient.on('reaction_added', async ({ event, ack }) => {
      await ack();
      if (event.user === botUserId) return;

      const user = await resolveUser(event.user);
      const channel = await resolveChannel(event.item.channel);
      const brokerPath = `slack/${workspace}/#${channel.name}`;

      try {
        messageBroker.route(`slack/${workspace}/${user.displayName}`, brokerPath, {
          command: 'slack.reaction',
          payload: {
            reaction: event.reaction,
            channelId: event.item.channel,
            channelName: channel.name,
            userId: event.user,
            userName: user.displayName,
            targetTs: event.item.ts,
          },
          source: 'slack',
          externalId: `reaction:${event.event_ts}`,
        });
      } catch (err) {
        log.error(`[slack-service] Failed to route reaction: ${err.message}`);
      }
    });

    // ─── App mentions (@bot) ─────────────────────────────────────────────

    socketClient.on('app_mention', async ({ event, ack }) => {
      await ack();

      const [user, channel] = await Promise.all([
        resolveUser(event.user),
        resolveChannel(event.channel),
      ]);

      const brokerPath = `slack/${workspace}/#${channel.name}`;

      log.info(`[slack-service] Mention by ${user.displayName} in #${channel.name}: ${(event.text || '').slice(0, 80)}`);

      try {
        messageBroker.route(`slack/${workspace}/${user.displayName}`, brokerPath, {
          command: 'slack.mention',
          payload: {
            text: event.text || '',
            channelId: event.channel,
            channelName: channel.name,
            userId: event.user,
            userName: user.displayName,
            threadTs: event.thread_ts || null,
            ts: event.ts,
          },
          source: 'slack',
          externalId: event.ts,
        });
      } catch (err) {
        log.error(`[slack-service] Failed to route mention: ${err.message}`);
      }
    });

    // ─── Slash commands ─────────────────────────────────────────────────

    socketClient.on('slash_commands', async ({ body, ack }) => {
      // body: { command, text, user_id, user_name, channel_id, channel_name,
      //         team_id, response_url, trigger_id, ... }
      const cmd = body.command;     // e.g. "/mobey"
      const text = body.text || ''; // everything after the command
      const userId = body.user_id;
      const channelId = body.channel_id;

      const [user, channel] = await Promise.all([
        resolveUser(userId),
        resolveChannel(channelId),
      ]);

      log.info(`[slack-service] Slash command ${cmd} from ${user.displayName} in #${channel.name}: ${text.slice(0, 80)}`);

      // Acknowledge immediately — Slack requires a response within 3s.
      // Send a placeholder; the agent's real response comes via the outbound path.
      await ack({ text: `Got it — processing \`${cmd} ${text}\`...` });

      try {
        messageBroker.route(`slack/${workspace}/${user.displayName}`, `slack/${workspace}/#${channel.name}`, {
          command: 'slack.slash',
          payload: {
            slashCommand: cmd,
            text,
            channelId,
            channelName: channel.name,
            userId,
            userName: user.displayName,
            responseUrl: body.response_url,
            triggerId: body.trigger_id,
          },
          source: 'slack',
          externalId: body.trigger_id,
        });
      } catch (err) {
        log.error(`[slack-service] Failed to route slash command: ${err.message}`);
      }
    });

    // ─── Outbound: Broker → Slack ─────────────────────────────────────────

    const senderAgentId = `_slack-sender-${workspace}`;
    messageBroker.subscribe(senderAgentId, `slack/${workspace}/**`);

    const OUTBOUND_COMMANDS = new Set([
      'slack.send', 'slack.reply', 'slack.slash_response',
    ]);

    const unsubListen = messageBroker.listen(senderAgentId, async (message) => {
      if (!OUTBOUND_COMMANDS.has(message.command)) return;

      const { channel, channelId, text, thread_ts, blocks, user, userName, responseUrl } = message.payload || {};

      // Slash command response — POST back to the response_url
      if (message.command === 'slack.slash_response' && responseUrl) {
        try {
          const axios = require('axios');
          await axios.post(responseUrl, {
            response_type: message.payload.responseType || 'ephemeral',
            text: text || '',
            ...(blocks ? { blocks } : {}),
          });
          log.info(`[slack-service] Slash response sent via response_url: ${(text || '').slice(0, 80)}`);
        } catch (err) {
          log.error(`[slack-service] Failed to send slash response: ${err.message}`);
        }
        return;
      }

      // Regular send / reply — resolve target channel
      let targetChannel = channelId || channel;

      // If targeting a user by name (DM), open the DM channel
      if (!targetChannel && (user || userName)) {
        const targetUser = findUserByName(user || userName);
        if (targetUser) {
          targetChannel = await openDM(targetUser.id);
        } else {
          log.warn(`[slack-service] Could not find user "${user || userName}" for DM`);
          return;
        }
      }

      // If target looks like a channel name (not an ID), resolve it
      if (targetChannel && !targetChannel.startsWith('C') && !targetChannel.startsWith('D') && !targetChannel.startsWith('G')) {
        const resolved = findChannelByName(targetChannel);
        if (resolved) {
          targetChannel = resolved;
        }
      }

      if (!targetChannel || !text) {
        log.warn(`[slack-service] Outbound message missing channel or text: ${JSON.stringify(message.payload)}`);
        return;
      }

      try {
        const postArgs = { channel: targetChannel, text };
        if (thread_ts) postArgs.thread_ts = thread_ts;
        if (blocks) postArgs.blocks = blocks;

        const result = await webClient.chat.postMessage(postArgs);
        log.info(`[slack-service] Sent to ${targetChannel}: ${text.slice(0, 80)} (ts: ${result.ts})`);
      } catch (err) {
        log.error(`[slack-service] Failed to send to ${targetChannel}: ${err.message}`);
      }
    });

    // ─── Connect ──────────────────────────────────────────────────────────

    socketClient.on('connected', async () => {
      log.info(`[slack-service] Connected to Slack workspace "${workspace}" via Socket Mode`);
      await reloadCaches();
    });

    socketClient.on('disconnected', () => {
      log.warn('[slack-service] Disconnected from Slack — will auto-reconnect');
    });

    // Periodic cache refresh
    const cacheTimer = setInterval(() => {
      reloadCaches().catch(err => {
        log.warn(`[slack-service] Cache refresh failed: ${err.message}`);
      });
    }, CACHE_TTL_MS);
    if (cacheTimer.unref) cacheTimer.unref();

    // Resolve our own bot user ID so we can ignore our own messages
    webClient.auth.test()
      .then(res => {
        botUserId = res.user_id;
        log.info(`[slack-service] Bot user ID: ${botUserId} (${res.user})`);
      })
      .catch(err => {
        log.warn(`[slack-service] Could not resolve bot user ID: ${err.message}`);
      });

    socketClient.start().catch(err => {
      log.error(`[slack-service] Failed to start Socket Mode: ${err.message}`);
    });

    // ─── Cleanup ──────────────────────────────────────────────────────────

    return () => {
      clearInterval(cacheTimer);
      unsubListen();
      socketClient.disconnect();
      log.info('[slack-service] Disconnected from Slack');
    };
  },
};
