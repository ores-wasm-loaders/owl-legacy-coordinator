// Telemetry: a small typed event bus the page (or ores-otel) subscribes to.
//
// Preparation is invisible by design, so without this there is no way to tell a fleet that
// prepares nothing from a fleet that prepares everything twice. Events carry no URLs beyond
// the app and release identifiers and no user data.

export const EVENTS = Object.freeze([
  'prepare:start',
  'prepare:done',
  'prepare:cancelled',
  'activate:start',
  'activate:done',
  'activate:stale-preparation',
  'deactivate',
]);

export class Telemetry {
  #listeners = new Map();
  #env;
  #history = [];

  constructor(env) {
    this.#env = env;
  }

  /** Subscribe. Returns an unsubscribe function. `'*'` receives every event. */
  on(event, listener) {
    if (event !== '*' && !EVENTS.includes(event)) throw new Error(`unknown loader event \`${event}\``);
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener);
    this.#listeners.set(event, set);
    return () => set.delete(listener);
  }

  emit(event, detail) {
    if (!EVENTS.includes(event)) throw new Error(`unknown loader event \`${event}\``);
    const record = Object.freeze({ event, at: this.#env.now(), ...detail });
    this.#history.push(record);
    for (const listener of this.#listeners.get(event) ?? []) listener(record);
    for (const listener of this.#listeners.get('*') ?? []) listener(record);
    this.#env.log?.(`[owl] ${event} ${JSON.stringify(detail)}`);
    return record;
  }

  /** Everything emitted so far, for a diagnostics panel or an acceptance assertion. */
  get history() {
    return [...this.#history];
  }
}
