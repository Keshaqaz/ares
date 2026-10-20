// Promises for Apps Script. The worker's code is async, but Apps Script calls tick, doGet and
// doPost synchronously and takes doPost's reply from its return value; native promises would
// settle only after the call has returned. The bundle swaps this class in for Promise (its
// async functions are compiled to generators over the global Promise, scripts/build-worker.ts),
// and settle() runs the reactions and the queued HTTP requests until the result is known.

type Reaction = () => void;
type Settled<T> = { state: 'fulfilled'; value: T } | { state: 'rejected'; reason: unknown };

// Reactions of settled promises, in order: the microtask queue that the call drains itself.
const jobs: Reaction[] = [];

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' && value !== null || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function';

export class SyncPromise<T> implements PromiseLike<T> {
  #settled: Settled<T> | null = null;
  #reactions: Reaction[] = [];

  constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason: unknown) => void) => void) {
    let done = false;
    const resolve = (value: T | PromiseLike<T>) => {
      if (done) return;
      done = true;
      if (value === this) this.#settle({ state: 'rejected', reason: new TypeError('a promise resolved with itself') });
      else if (thenable(value)) jobs.push(() => {
        try {
          value.then(v => this.#settle({ state: 'fulfilled', value: v }), reason => this.#settle({ state: 'rejected', reason }));
        } catch (error) { this.#settle({ state: 'rejected', reason: error }); }
      });
      else this.#settle({ state: 'fulfilled', value });
    };
    const reject = (reason: unknown) => {
      if (done) return;
      done = true;
      this.#settle({ state: 'rejected', reason });
    };
    try { executor(resolve, reject); } catch (error) { reject(error); }
  }

  #settle(settled: Settled<T>): void {
    if (this.#settled) return;
    this.#settled = settled;
    jobs.push(...this.#reactions);
    this.#reactions = [];
  }

  then<A = T, B = never>(onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): SyncPromise<A | B> {
    return new SyncPromise<A | B>((resolve, reject) => {
      const react = () => {
        const settled = this.#settled;
        if (!settled) return;
        try {
          if (settled.state === 'fulfilled') {
            if (onFulfilled) resolve(onFulfilled(settled.value));
            else resolve(settled.value as unknown as A);
          } else if (onRejected) resolve(onRejected(settled.reason));
          else reject(settled.reason);
        } catch (error) { reject(error); }
      };
      if (this.#settled) jobs.push(react);
      else this.#reactions.push(react);
    });
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): SyncPromise<T | B> {
    return this.then(undefined, onRejected);
  }

  finally(onFinally?: (() => void) | null): SyncPromise<T> {
    return this.then(value => { onFinally?.(); return value; }, reason => { onFinally?.(); throw reason; });
  }

  static resolve<T>(value: T | PromiseLike<T>): SyncPromise<T> {
    return value instanceof SyncPromise ? value : new SyncPromise<T>(resolve => resolve(value));
  }

  static reject<T = never>(reason: unknown): SyncPromise<T> {
    return new SyncPromise<T>((_, reject) => reject(reason));
  }

  static all<T>(values: Iterable<T | PromiseLike<T>>): SyncPromise<Awaited<T>[]> {
    return new SyncPromise((resolve, reject) => {
      const list = [...values];
      const results: Awaited<T>[] = new Array(list.length);
      let left = list.length;
      if (!left) resolve(results);
      list.forEach((value, i) => SyncPromise.resolve(value).then(result => {
        results[i] = result as Awaited<T>;
        if (--left === 0) resolve(results);
      }, reject));
    });
  }
}

// The result of promise, within this call. Between rounds of reactions, flush() sends the HTTP
// requests waiting for a reply and returns false when there were none: then nothing is left
// that could settle the promise.
export function settle<T>(promise: PromiseLike<T>, flush: () => boolean): T {
  const result: { settled: Settled<T> | null } = { settled: null };
  promise.then(value => { result.settled = { state: 'fulfilled', value }; }, reason => { result.settled = { state: 'rejected', reason }; });
  for (;;) {
    while (jobs.length) jobs.shift()?.();
    const done = result.settled;
    if (done) {
      if (done.state === 'rejected') throw done.reason;
      return done.value;
    }
    if (!flush()) throw new Error('the worker waits for something that never comes');
  }
}
