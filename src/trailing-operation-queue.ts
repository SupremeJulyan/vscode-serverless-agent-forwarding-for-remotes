interface QueueState {
  dirty: boolean;
}

/**
 * Runs one operation per key at a time. Events arriving while it runs are
 * collapsed into one trailing rerun, so the final filesystem state is never
 * lost while avoiding an upload for every watcher event in a burst.
 */
export class TrailingOperationQueue {
  private readonly states = new Map<string, QueueState>();

  constructor(private readonly onError: (error: unknown) => void = () => undefined) {}

  enqueue(key: string, operation: () => Promise<void>, onIdle?: () => void): boolean {
    const existing = this.states.get(key);
    if (existing) {
      existing.dirty = true;
      return false;
    }
    const state: QueueState = { dirty: false };
    this.states.set(key, state);
    // Defer execution one microtask so callers can publish their own pending
    // state before the operation begins.
    void Promise.resolve().then(async () => {
      do {
        state.dirty = false;
        await operation();
      } while (state.dirty);
    }).catch(this.onError).finally(() => {
      if (this.states.get(key) === state) this.states.delete(key);
      onIdle?.();
    });
    return true;
  }
}
