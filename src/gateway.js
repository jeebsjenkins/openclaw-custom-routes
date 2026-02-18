const crypto = require('crypto');
const os = require('os');
const WebSocket = require('ws');
const config = require('../config');
const { loadOrCreateIdentity, signPayload, buildAuthPayload } = require('./deviceIdentity');

let ws = null;
let handshakeDone = false;
const pending = new Map(); // id -> { resolve, reject, timer }

const CLIENT_ID = 'openclaw-control-ui';
const CLIENT_MODE = 'webchat';
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write'];

/**
 * Generate a unique request ID.
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * Connect to the OpenClaw gateway over WebSocket.
 * Handles the connect.challenge → connect handshake with device signing.
 * @returns {Promise<void>}
 */
function connect() {
  return new Promise(async (outerResolve, outerReject) => {
    try {
      if (!config.openclawGateway) {
        return outerReject(new Error('OPENCLAW_GATEWAY is not configured'));
      }
      if (!config.openclawGatewayToken) {
        return outerReject(new Error('OPENCLAW_GATEWAY_TOKEN is not configured'));
      }

      const identity = await loadOrCreateIdentity();
      console.log(`[gateway] device id: ${identity.deviceId}`);

      // Convert http(s):// to ws(s):// and pass token as query param
      const wsUrl = config.openclawGateway
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');

      const urlWithToken = `${wsUrl}?token=${encodeURIComponent(config.openclawGatewayToken)}`;

      handshakeDone = false;
      ws = new WebSocket(urlWithToken, {
        headers: { Origin: config.openclawGateway },
      });

      let connectReqId = null;
      let resolved = false;

      function finish(err) {
        if (resolved) return;
        resolved = true;
        if (err) outerReject(err);
        else outerResolve();
      }

      ws.on('open', () => {
        console.log('[gateway] WebSocket open, waiting for challenge...');
      });

      ws.on('message', async (data) => {
        console.log('[gateway] raw message:', data.toString());
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }

        // Handle challenge during handshake
        if (msg.type === 'event' && msg.event === 'connect.challenge' && msg.payload?.nonce) {
          console.log('[gateway] received challenge, signing and sending connect request...');
          try {
            connectReqId = generateId();
            const signedAtMs = Date.now();
            const payload = buildAuthPayload({
              deviceId: identity.deviceId,
              clientId: CLIENT_ID,
              clientMode: CLIENT_MODE,
              role: ROLE,
              scopes: SCOPES,
              signedAtMs,
              token: config.openclawGatewayToken,
              nonce: msg.payload.nonce,
            });
            const signature = await signPayload(identity.privateKey, payload);

            const connectMsg = {
              type: 'req',
              id: connectReqId,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: CLIENT_ID,
                  version: '1.0.0',
                  platform: os.platform(),
                  mode: CLIENT_MODE,
                },
                role: ROLE,
                scopes: SCOPES,
                auth: { token: config.openclawGatewayToken },
                device: {
                  id: identity.deviceId,
                  publicKey: identity.publicKey,
                  signature,
                  signedAt: signedAtMs,
                  nonce: msg.payload.nonce,
                },
              },
            };
            ws.send(JSON.stringify(connectMsg));
          } catch (err) {
            finish(new Error(`Failed to sign challenge: ${err.message}`));
          }
          return;
        }

        // Handle handshake response
        if (!handshakeDone && msg.id === connectReqId) {
          if (msg.ok === false || msg.type === 'error' || msg.error) {
            const errMsg = msg.error?.message || msg.error || 'Gateway handshake failed';
            finish(new Error(errMsg));
          } else {
            console.log('[gateway] handshake complete');
            handshakeDone = true;
            finish();
          }
          return;
        }

        // Normal message routing
        const entry = pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(msg.id);

          if (msg.type === 'tool_result') {
            entry.resolve(msg.result);
          } else if (msg.type === 'res') {
            entry.resolve(msg.result || msg);
          } else if (msg.type === 'error') {
            entry.reject(new Error(msg.error || 'Gateway returned an error'));
          } else {
            entry.resolve(msg);
          }
        }
      });

      ws.on('error', (err) => {
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(err);
        }
        pending.clear();
        finish(err);
      });

      ws.on('close', (code, reason) => {
        console.log(`[gateway] connection closed: code=${code} reason=${reason?.toString() || '(none)'}`);
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Gateway connection closed'));
        }
        pending.clear();
        handshakeDone = false;
        ws = null;
        finish(new Error(`Gateway connection closed (code=${code})`));
      });
    } catch (err) {
      outerReject(err);
    }
  });
}

/**
 * Send a message to the gateway and wait for the response.
 * @param {Object} message - The full message object (must include id and type)
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<Object>} The result from the gateway response
 */
function send(message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('Gateway not connected'));
    }
    if (!handshakeDone) {
      return reject(new Error('Gateway handshake not complete'));
    }

    const id = message.id || generateId();
    const msg = { ...message, id };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Gateway request ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });

    ws.send(JSON.stringify(msg), (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

/**
 * Check if the gateway WebSocket is connected and handshake is done.
 * @returns {{ connected: boolean }}
 */
function healthCheck() {
  return {
    connected: ws !== null && ws.readyState === WebSocket.OPEN && handshakeDone,
  };
}

/**
 * Get the underlying WebSocket instance.
 * @returns {WebSocket}
 */
function getConnection() {
  if (!ws) {
    throw new Error('Gateway not connected. Call connect() first.');
  }
  return ws;
}

module.exports = {
  connect,
  send,
  healthCheck,
  generateId,
  getConnection,
};
