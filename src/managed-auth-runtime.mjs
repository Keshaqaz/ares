import { AuthFailure } from './auth-bundle.mjs';

// 0.160.1 exposes no affirmative barrier for hidden auth task completion or file-save
// success. Successful account/read, unchanged auth.json and process exit cannot stand
// in for it. This adapter deliberately refuses activation before spawning a process.
export class ManagedAuthRuntime {
  authBarrierSupported = false;
  async open() { throw new AuthFailure('runtime_auth_barrier_unavailable'); }
}
