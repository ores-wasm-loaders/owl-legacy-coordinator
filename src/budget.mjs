// Bounded preparation: a byte ceiling, a concurrency ceiling, and cancellation.
//
// Preparation is speculative work done on someone else's behalf — a visitor who may never
// click. It therefore stops at a stated budget instead of taking whatever the network will
// give it, and it is always cancellable.

export class Budget {
  #maxBytes;
  #maxConcurrency;
  #spent = 0;
  #inFlight = 0;
  #queue = [];

  constructor({ maxBytes, maxConcurrency }) {
    if (!(maxBytes >= 0)) throw new Error('budget needs a non-negative maxBytes');
    if (!(maxConcurrency >= 1)) throw new Error('budget needs maxConcurrency >= 1');
    this.#maxBytes = maxBytes;
    this.#maxConcurrency = maxConcurrency;
  }

  get spent() {
    return this.#spent;
  }

  get remaining() {
    return Math.max(0, this.#maxBytes - this.#spent);
  }

  /** Would a transfer of `bytes` fit? A zero-byte item always fits. */
  admits(bytes) {
    return bytes === 0 || this.#spent + bytes <= this.#maxBytes;
  }

  /** Reserve the bytes of an item that is about to be fetched. */
  reserve(bytes) {
    if (!this.admits(bytes)) return false;
    this.#spent += bytes;
    return true;
  }

  /** Give back the difference when a transfer turned out smaller (or failed). */
  release(bytes) {
    this.#spent = Math.max(0, this.#spent - bytes);
  }

  /** Run `task` when a concurrency slot frees up. Preserves submission order. */
  async slot(task) {
    if (this.#inFlight >= this.#maxConcurrency) {
      await new Promise((resolve) => this.#queue.push(resolve));
    }
    this.#inFlight += 1;
    try {
      return await task();
    } finally {
      this.#inFlight -= 1;
      const next = this.#queue.shift();
      if (next) next();
    }
  }
}

/**
 * Walk `items` in order under the budget, calling `run(item)` for each that fits.
 * Returns what was prepared, what was skipped, and why — never throws for a skipped item,
 * because preparation failing is a non-event for correctness.
 */
export async function spend(items, budget, run, { signal } = {}) {
  const prepared = [];
  const skipped = [];
  for (const item of items) {
    if (signal?.aborted) {
      skipped.push({ item, reason: 'cancelled' });
      continue;
    }
    if (!budget.reserve(item.bytes)) {
      skipped.push({ item, reason: 'over-budget' });
      continue;
    }
    try {
      const value = await budget.slot(() => run(item));
      prepared.push({ item, value });
    } catch (error) {
      budget.release(item.bytes);
      skipped.push({ item, reason: signal?.aborted ? 'cancelled' : 'failed', error });
    }
  }
  return { prepared, skipped };
}
