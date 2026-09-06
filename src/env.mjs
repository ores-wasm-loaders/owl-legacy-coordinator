// The coordinator never touches an ambient global. Everything it can observe or change in
// the page arrives through an environment object, which makes the whole scheduler testable
// without a browser and makes "what can preparation reach?" a reviewable list rather than a
// convention.

/** @typedef {{fetch: typeof fetch, now: () => number, document?: Document, wasm?: typeof WebAssembly, idle?: (cb: () => void) => unknown, log?: (line: string) => void}} Env */

/** Capture the real browser environment. Called once, at the edge, by the page. */
export function browserEnv(globalObject) {
  const g = globalObject;
  return Object.freeze({
    fetch: g.fetch.bind(g),
    now: () => (g.performance ? g.performance.now() : Date.now()),
    document: g.document,
    wasm: g.WebAssembly,
    idle: g.requestIdleCallback ? g.requestIdleCallback.bind(g) : (cb) => g.setTimeout(cb, 1),
    log: undefined,
  });
}

/**
 * The capability set preparation runs with: fetching and nothing else.
 *
 * There is no document, no module loader and no way back to the page, so an adapter's
 * prepare step physically cannot insert a script, start an engine, or reach an ambient
 * global — the restriction is structural, not a rule adapters are asked to follow.
 */
export function prepareCapabilities(env, { signal, compile }) {
  return Object.freeze({
    fetch: env.fetch,
    signal,
    /** Present only when the release's policy allows compilation AND the runtime offers it. */
    compileStreaming: compile && env.wasm?.compileStreaming ? env.wasm.compileStreaming.bind(env.wasm) : null,
    log: (line) => env.log?.(line),
  });
}

/** The capability set activation runs with: the page itself, because activation owns it. */
export function activateCapabilities(env, { signal, host, prepared }) {
  if (!env.document) throw new Error('activation needs a document: the coordinator was built with a headless environment');
  return Object.freeze({
    document: env.document,
    fetch: env.fetch,
    wasm: env.wasm,
    signal,
    host,
    prepared,
    now: env.now,
    log: (line) => env.log?.(line),
  });
}
