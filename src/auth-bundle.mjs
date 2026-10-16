import { createHash, randomUUID } from 'node:crypto';

export class AuthFailure extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export function grantFingerprint(grant) {
  if (typeof grant !== 'string' || !grant || Buffer.byteLength(grant) > 8192) throw new AuthFailure('invalid_grant');
  return hash(grant);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const fail = () => { throw new AuthFailure('invalid_auth_bundle'); };

// JWT decoding checks consistency, not signatures or server entitlement.
export function managedIdentity(bytes) {
  try {
    const auth = JSON.parse(bytes.toString('utf8'));
    if (!only(auth, ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh']) || auth.auth_mode !== 'chatgpt' ||
        auth.OPENAI_API_KEY != null || !only(auth.tokens, ['access_token', 'id_token', 'refresh_token', 'account_id']) ||
        !['access_token', 'id_token', 'refresh_token', 'account_id'].every(key => nonempty(auth.tokens[key])) ||
        !nonempty(auth.last_refresh) || !Number.isFinite(Date.parse(auth.last_refresh))) fail();
    const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!nonempty(accountId) || accountId !== auth.tokens.account_id) fail();
    return hash(JSON.stringify({ accountId }));
  } catch { fail(); }
}

export function hostCredentials(bytes) {
  try {
    managedIdentity(bytes);
    const auth = JSON.parse(bytes.toString('utf8'));
    const claims = token => {
      const parts = token.split('.');
      if (parts.length !== 3) fail();
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    };
    const id = claims(auth.tokens.id_token)['https://api.openai.com/auth'];
    const accessClaims = claims(auth.tokens.access_token);
    const access = accessClaims['https://api.openai.com/auth'];
    // chatgpt_account_id identifies the selected workspace; user ID binds the login.
    if (!nonempty(id?.chatgpt_user_id) || access?.chatgpt_account_id !== auth.tokens.account_id ||
        access?.chatgpt_user_id !== id.chatgpt_user_id) fail();
    return { auth, accountId: auth.tokens.account_id, userId: id.chatgpt_user_id,
      planType: nonempty(access.chatgpt_plan_type) ? access.chatgpt_plan_type : null,
      expiresAt: Number.isSafeInteger(accessClaims.exp) ? accessClaims.exp : null,
      identityDigest: hash(JSON.stringify({ accountId: auth.tokens.account_id, userId: id.chatgpt_user_id })) };
  } catch { fail(); }
}

export function tuple(bundle) {
  return { sessionId: bundle.sessionId, generation: bundle.generation, bundleId: bundle.bundleId,
    digest: bundle.digest, identityDigest: bundle.identityDigest };
}
export function validTuple(value) {
  return only(value, ['sessionId', 'generation', 'bundleId', 'digest', 'identityDigest']) &&
    uuid(value.sessionId) && uuid(value.bundleId) && Number.isSafeInteger(value.generation) &&
    value.generation > 0 && digest(value.digest) && digest(value.identityDigest);
}
export const sameTuple = (a, b) => validTuple(a) && validTuple(b) &&
  ['sessionId', 'generation', 'bundleId', 'digest', 'identityDigest'].every(key => a[key] === b[key]);

export function makeBundle(bytes, { previous = null, sessionId = randomUUID(), protocol = previous?.schema ?? 1 } = {}) {
  bytes = Buffer.from(bytes);
  const identityDigest = protocol === 2 ? hostCredentials(bytes).identityDigest : managedIdentity(bytes);
  if (previous && previous.identityDigest !== identityDigest) throw new AuthFailure('identity_changed');
  const bundle = { schema: protocol, sessionId: previous?.sessionId ?? sessionId,
    generation: previous ? previous.generation + 1 : 1, bundleId: randomUUID(),
    digest: hash(bytes), identityDigest, authBase64: bytes.toString('base64') };
  encodeBundle(bundle); // Validate size before writing a target that cannot be published.
  return bundle;
}
export function encodeBundle(bundle) {
  const encoded = JSON.stringify(bundle);
  decodeBundle(encoded);
  return encoded;
}
export function decodeBundle(encoded) {
  try {
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 48 * 1024) fail();
    const b = JSON.parse(encoded);
    if (!only(b, ['schema', 'sessionId', 'generation', 'bundleId', 'digest', 'identityDigest', 'authBase64']) ||
        ![1, 2].includes(b.schema) || !validTuple(tuple(b)) || !nonempty(b.authBase64)) fail();
    const bytes = Buffer.from(b.authBase64, 'base64');
    if (bytes.toString('base64') !== b.authBase64 || hash(bytes) !== b.digest ||
        (b.schema === 2 ? hostCredentials(bytes).identityDigest : managedIdentity(bytes)) !== b.identityDigest) fail();
    return b;
  } catch { fail(); }
}
export const bundleBytes = bundle => Buffer.from(decodeBundle(encodeBundle(bundle)).authBase64, 'base64');

// Auth records contain only random identities, digests and fixed enums. No credentials/email.
export function validateAuth(auth) {
  const invalid = () => { throw new AuthFailure('invalid_auth_state'); };
  if (!only(auth, ['schema', 'protocol', 'phase', 'committed', 'target', 'operationId', 'owner',
    'grantFingerprint', 'reconnectReason', 'receipt', 'transition']) || auth.schema !== 1 || ![1, 2].includes(auth.protocol) ||
    !['ready', 'inflight', 'publishing'].includes(auth.phase) ||
    !(validTuple(auth.committed) || auth.committed === null && auth.phase === 'publishing' && auth.transition === 'seed') ||
    !(auth.target === null || validTuple(auth.target)) || !digest(auth.grantFingerprint) ||
    !(auth.operationId === null || uuid(auth.operationId)) ||
    !(auth.owner === null || typeof auth.owner === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(auth.owner)) ||
    !(auth.reconnectReason === null || ['auth_failed', 'runtime_barrier_failed', 'revoked'].includes(auth.reconnectReason)) ||
    ![null, 'rotation', 'seed'].includes(auth.transition) ||
    !(auth.receipt === null || ['accountRead', 'limitsRead', 'reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed', 'unknown'].includes(auth.receipt))) invalid();
  if (auth.phase === 'ready' && (auth.target !== null || auth.operationId !== null || auth.owner !== null) ||
      auth.phase !== 'ready' && (auth.operationId === null || auth.owner === null) ||
      auth.phase === 'inflight' && auth.target !== null || auth.phase === 'publishing' && auth.target === null) invalid();
  if (auth.phase === 'ready' && auth.transition !== null || auth.phase === 'inflight' && auth.transition !== 'rotation' ||
      auth.phase === 'publishing' && auth.transition === null) invalid();
  if (auth.target && auth.transition === 'rotation' && (auth.target.sessionId !== auth.committed.sessionId ||
      auth.target.identityDigest !== auth.committed.identityDigest ||
      auth.target.generation !== auth.committed.generation + 1)) invalid();
  if (auth.transition === 'seed' && (auth.target?.generation !== 1 ||
      auth.target.sessionId === auth.committed?.sessionId)) invalid();
}

export function readyAuth(bundle, grant) {
  const record = { schema: 1, protocol: bundle.schema, phase: 'ready', committed: tuple(bundle), target: null,
    operationId: null, owner: null, grantFingerprint: grantFingerprint(grant), reconnectReason: null, receipt: null, transition: null };
  validateAuth(record);
  return record;
}
