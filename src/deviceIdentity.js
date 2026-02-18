const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ed = require('@noble/ed25519');

const IDENTITY_FILE = path.join(__dirname, '..', '.device-identity.json');

function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlDecode(input) {
  return new Uint8Array(Buffer.from(input, 'base64url'));
}

async function fingerprintPublicKey(publicKey) {
  const hash = crypto.createHash('sha256').update(publicKey).digest('hex');
  return hash;
}

async function generateIdentity() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

async function loadOrCreateIdentity() {
  try {
    if (fs.existsSync(IDENTITY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
      if (raw?.version === 1 && raw.deviceId && raw.publicKey && raw.privateKey) {
        return { deviceId: raw.deviceId, publicKey: raw.publicKey, privateKey: raw.privateKey };
      }
    }
  } catch { /* regenerate */ }

  const identity = await generateIdentity();
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify({
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  }, null, 2));
  return identity;
}

async function signPayload(privateKeyBase64Url, payload) {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await ed.signAsync(data, key);
  return base64UrlEncode(sig);
}

function buildAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  const version = nonce ? 'v2' : 'v1';
  const base = [version, deviceId, clientId, clientMode, role, scopes.join(','), String(signedAtMs), token || ''];
  if (version === 'v2') base.push(nonce || '');
  return base.join('|');
}

module.exports = {
  loadOrCreateIdentity,
  signPayload,
  buildAuthPayload,
};
