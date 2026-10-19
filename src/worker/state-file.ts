import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { object, asObject } from '../chatgpt/http.ts';
import type { Session } from '../chatgpt/session.ts';
import type { Quotas, IssuedReset, ConsumeResult } from '../chatgpt/client.ts';

// A file of a known formatVersion whose other fields are not checked yet.
export type Versioned = Record<string, unknown> & { formatVersion: number };
// One format step; the migration sets the new formatVersion itself.
export type Migration = (old: Versioned) => Record<string, unknown>;

// Format steps: steps[i] turns formatVersion i + 1 into i + 2, so the current version is
// steps.length + 1. A format change appends its step. The worker migrates state when it
// opens it (and tick, for a state handed to it directly); `upgrade` migrates the rules file, and the worker reads older rules meanwhile.
export const STATE_MIGRATIONS: Migration[] = [];
export const RULES_MIGRATIONS: Migration[] = [];
export const STATE_FORMAT_VERSION = STATE_MIGRATIONS.length + 1;
export const RULES_FORMAT_VERSION = RULES_MIGRATIONS.length + 1;
// Version of the encryption envelope, separate from the state's own formatVersion.
const ENVELOPE_VERSION = 1;
const CIPHER = 'aes-256-gcm';
// Binds the ciphertext to its role, so no other file sealed with this key opens as state.
const AAD = Buffer.from('codex-auto-resets/state');

// Why a reset is applied: a general rule or «Применить сейчас».
export type ApplyReason = 'weekly' | 'before_expiry' | 'apply_now';
// recovers is the renewsAt of the exhausted weekly window the reset restores, null when the quota was not exhausted.
export interface Applied { creditId: string; expiresAt: number | null; reason: ApplyReason; at: number; recovers: number | null }
// A consume whose result is not known yet; redeemRequestId is reused by its retries.
export type Pending = Applied & { redeemRequestId: string };
// unknown: the reset expired before its result was settled; missing: applyNow named no listed reset.
export type AttemptResult = ConsumeResult | 'unknown' | 'missing';
export interface LastAttempt { creditId: string; reason: ApplyReason; at: number; result: AttemptResult }
export type Observed = Quotas & { at: number; resets: IssuedReset[] };
// The verdict on a login secret, which the CLI matches by id.
export interface LoginVerdict { id: string; result: 'accepted' | 'rejected'; at: number }
// The worker's encrypted state. Setup writes only formatVersion, session, pending and applied.
export interface State {
  formatVersion: number;
  session: Session;
  pending?: Pending | null;
  applied?: Applied[];
  observed?: Observed;
  lastAttempt?: LastAttempt;
  login?: LoginVerdict;
}
export interface Rules { formatVersion: number; beforeExpiry: boolean; weeklyAutoApply: boolean }
// The login secret the CLI writes.
export interface Login { id: string; session: Session }

export type BrokenStateReason = 'key_invalid' | 'state_missing' | 'state_unreadable' | 'state_undecryptable' |
  'state_format_unknown' | 'state_without_session' | 'rules_missing' | 'rules_unreadable' | 'rules_format_unknown';

// The worker cannot read its own repository files and only the user can fix them:
// a lost or wrong key, a tampered or unknown state, unreadable rules.
export class BrokenState extends Error {
  reason: BrokenStateReason;
  constructor(reason: BrokenStateReason) { super(reason); this.reason = reason; }
}

const known = (value: unknown, steps: Migration[]): value is Versioned => object(value) &&
  Number.isInteger(value.formatVersion) && Number(value.formatVersion) >= 1 && Number(value.formatVersion) <= steps.length + 1;
const migrate = (value: Versioned, steps: Migration[]): Versioned => steps.slice(value.formatVersion - 1)
  .reduce<Versioned>((old, step) => ({ ...step(old), formatVersion: old.formatVersion + 1 }), value);
// The only check the state gets: the rest of it is the worker's own writing.
const withSession = (state: Versioned): state is Versioned & State => typeof asObject(state.session)?.refreshToken === 'string';

// State of any known formatVersion in the current one.
export function migrateState(state: unknown, steps: Migration[] = STATE_MIGRATIONS): State {
  if (!known(state, steps)) throw new BrokenState('state_format_unknown');
  const migrated = migrate(state, steps);
  if (!withSession(migrated)) throw new BrokenState('state_without_session');
  return migrated;
}

// `setup` generates the key once and stores it base64 in the Actions secret.
export const generateKey = (): string => randomBytes(32).toString('base64');

function keyBytes(key: string | undefined): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64') : null;
  if (bytes?.length !== 32) throw new BrokenState('key_invalid');
  return bytes;
}

export function sealState(state: State, key: string | undefined): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, keyBytes(key), iv).setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return `${JSON.stringify({ formatVersion: ENVELOPE_VERSION, cipher: CIPHER, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })}\n`;
}

// key is the STATE_KEY secret as the runner hands it: possibly unset.
export function openState(text: string, key: string | undefined): State {
  const bytes = keyBytes(key);
  let envelope;
  try { envelope = asObject(JSON.parse(text)); } catch { throw new BrokenState('state_unreadable'); }
  if (envelope?.formatVersion !== ENVELOPE_VERSION || envelope.cipher !== CIPHER) throw new BrokenState('state_unreadable');
  const { iv, tag, data } = envelope;
  let plain;
  try {
    if (typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') throw new TypeError('envelope');
    const decipher = createDecipheriv(CIPHER, bytes, Buffer.from(iv, 'base64'), { authTagLength: 16 }).setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw new BrokenState('state_undecryptable'); }
  let state: unknown;
  try { state = JSON.parse(plain); } catch { throw new BrokenState('state_unreadable'); }
  return migrateState(state);
}

// The fields of a session the worker relies on; idToken is not checked.
const isSession = (value: unknown): value is Session => object(value) && typeof value.refreshToken === 'string' &&
  typeof value.accessToken === 'string' && typeof value.accountId === 'string';

// The login secret the CLI writes: { id, session }. Anything else is null: it is not the
// state, and the worker keeps its own session.
export function readLogin(text: string): Login | null {
  let login;
  try { login = asObject(JSON.parse(text)); } catch { return null; }
  const { id, session } = login ?? {};
  if (typeof id !== 'string' || !id || !isSession(session)) return null;
  return { id, session };
}

// Rules are open JSON that only the CLI writes; an older formatVersion comes back in the current one.
export function readRules(text: string, steps: Migration[] = RULES_MIGRATIONS): Rules {
  let rules: unknown;
  try { rules = JSON.parse(text); } catch { throw new BrokenState('rules_unreadable'); }
  if (!known(rules, steps)) throw new BrokenState('rules_format_unknown');
  const { formatVersion, beforeExpiry, weeklyAutoApply } = migrate(rules, steps);
  if (typeof beforeExpiry !== 'boolean' || typeof weeklyAutoApply !== 'boolean') throw new BrokenState('rules_unreadable');
  return { formatVersion, beforeExpiry, weeklyAutoApply };
}
