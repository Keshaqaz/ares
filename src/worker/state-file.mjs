import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const STATE_FORMAT_VERSION = 1;
export const RULES_FORMAT_VERSION = 1;
// Version of the encryption envelope, separate from the state's own formatVersion.
const ENVELOPE_VERSION = 1;
const CIPHER = 'aes-256-gcm';
// Binds the ciphertext to its role, so no other file sealed with this key opens as state.
const AAD = Buffer.from('codex-auto-resets/state');

// The worker cannot read its own repository files and only the user can fix them:
// a lost or wrong key, a tampered or unknown state, unreadable rules.
export class BrokenState extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

// The installer generates the key once and stores it base64 in the Actions secret.
export const generateKey = () => randomBytes(32).toString('base64');

function keyBytes(key) {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64') : null;
  if (bytes?.length !== 32) throw new BrokenState('key_invalid');
  return bytes;
}

export function sealState(state, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, keyBytes(key), iv).setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return `${JSON.stringify({ formatVersion: ENVELOPE_VERSION, cipher: CIPHER, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })}\n`;
}

export function openState(text, key) {
  const bytes = keyBytes(key);
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new BrokenState('state_unreadable'); }
  if (envelope?.formatVersion !== ENVELOPE_VERSION || envelope.cipher !== CIPHER) throw new BrokenState('state_unreadable');
  let plain;
  try {
    const decipher = createDecipheriv(CIPHER, bytes, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 }).setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new BrokenState('state_undecryptable'); }
  let state;
  try { state = JSON.parse(plain); } catch { throw new BrokenState('state_unreadable'); }
  if (state?.formatVersion !== STATE_FORMAT_VERSION) throw new BrokenState('state_format_unknown');
  if (typeof state.session?.refreshToken !== 'string') throw new BrokenState('state_without_session');
  return state;
}

// Rules are open JSON that only the CLI writes.
export function readRules(text) {
  let rules;
  try { rules = JSON.parse(text); } catch { throw new BrokenState('rules_unreadable'); }
  if (rules?.formatVersion !== RULES_FORMAT_VERSION) throw new BrokenState('rules_format_unknown');
  if (typeof rules.beforeExpiry !== 'boolean' || typeof rules.weeklyAutoApply !== 'boolean') throw new BrokenState('rules_unreadable');
  return { formatVersion: rules.formatVersion, beforeExpiry: rules.beforeExpiry, weeklyAutoApply: rules.weeklyAutoApply };
}
