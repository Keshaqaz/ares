// No Node imports: shared with the Cloudflare timer bundle (worker/index.mjs).
export class StateFailure extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}
export const integer = value => Number.isSafeInteger(value);
