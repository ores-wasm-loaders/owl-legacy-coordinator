// The coordinator: the framework-independent half of the loading layer.
//
// It owns exactly two verbs, and the distance between them is the whole point of this org:
//
//   prepare(appId)            fetch-only, bounded, cancellable, side-effect free.
//                             Never executes application code, authenticates, subscribes,
//                             or writes. Failing is a non-event.
//
//   activate(appId, host)     starts or reuses the application in THIS document, using
//                             whatever preparation happened to leave behind — and working
//                             correctly when none did.
//
// What it deliberately does not claim: that a running application survives a normal
// navigation. It does not. Only a persistent shell keeps a runtime alive; everything else
// is byte and compilation reuse, which the browser grants at its discretion.

import { prepareCapabilities, activateCapabilities } from './env.mjs';
import { Budget, spend } from './budget.mjs';
import { Registry } from './registry.mjs';
import { emitHints } from './hints.mjs';
import { Telemetry } from './telemetry.mjs';

const WASM_TYPE = 'application/wasm';

/** Default preparation of one asset: pull the bytes, optionally compile a Wasm module. */
async function defaultPrepareAsset(caps, item, url) {
  const response = await caps.fetch(url, { signal: caps.signal, credentials: 'omit', mode: 'cors' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (caps.compileStreaming && item.contentType === WASM_TYPE) {
    // Compiling here only helps when the adapter's activation path can accept a Module.
    // When it cannot, the bytes still land in an eligible cache, which is the real win.
    return { kind: 'module', module: await caps.compileStreaming(response), bytes: item.bytes };
  }
  const body = await response.arrayBuffer();
  return { kind: 'bytes', bytes: body.byteLength };
}

export class Coordinator {
  #env;
  #registry;
  #adapters = new Map();
  #preparations = new Map(); // appId -> receipt
  #inFlightPrepare = new Map(); // appId -> promise
  #inFlightActivate = new Map(); // `${appId}@${releaseId}` -> promise
  #instances = new Map(); // `${appId}@${releaseId}` -> instance
  #aborts = new Map(); // appId -> AbortController
  #telemetry;
  #defaults;

  constructor({ env, validate, adapters = [], defaults = {} }) {
    this.#env = env;
    this.#registry = new Registry({ validate });
    this.#telemetry = new Telemetry(env);
    this.#defaults = { maxBytes: 8_000_000, maxConcurrency: 4, ...defaults };
    for (const a of adapters) this.use(a);
  }

  /**
   * Register a framework adapter. One per framework, replacing any earlier registration.
   *
   * An adapter is `{ framework, supports?, plan(manifest), prepareAsset?(caps, item, url),
   * activate(caps, manifest, options), deactivate?(instance) }`. `plan` is required rather
   * than defaulted here so the asset-ordering rule lives in owl-interfaces alone.
   */
  use(adapter) {
    for (const required of ['framework', 'plan', 'activate']) {
      if (!adapter?.[required]) throw new Error(`adapter is missing \`${required}\``);
    }
    this.#adapters.set(adapter.framework, adapter);
    return this;
  }

  get registry() {
    return this.#registry;
  }

  get telemetry() {
    return this.#telemetry;
  }

  on(event, listener) {
    return this.#telemetry.on(event, listener);
  }

  register(manifest) {
    return this.#registry.register(manifest);
  }

  loadManifest(url, options = {}) {
    return this.#registry.load(url, { fetch: this.#env.fetch, ...options });
  }

  #adapterFor(manifest) {
    const adapter = this.#adapters.get(manifest.framework);
    if (!adapter) {
      throw new Error(`no adapter registered for framework \`${manifest.framework}\` (have: ${[...this.#adapters.keys()].join(', ') || 'none'})`);
    }
    return adapter;
  }

  /** What preparation has already achieved for this app, if anything. */
  preparationOf(appId) {
    return this.#preparations.get(appId) ?? null;
  }

  /**
   * Prepare an application without starting it.
   *
   * Concurrent calls for the same app share one operation. Re-preparing after a release
   * changes discards the stale receipt rather than mixing releases.
   */
  prepare(appId, options = {}) {
    const existing = this.#inFlightPrepare.get(appId);
    if (existing) return existing;

    const manifest = this.#registry.get(appId);
    const done = this.preparationOf(appId);
    if (done && done.releaseId === manifest.releaseId && !options.force) {
      return Promise.resolve(done);
    }

    const promise = this.#prepare(manifest, options).finally(() => {
      this.#inFlightPrepare.delete(appId);
    });
    this.#inFlightPrepare.set(appId, promise);
    return promise;
  }

  async #prepare(manifest, options) {
    const adapter = this.#adapterFor(manifest);
    const controller = new AbortController();
    this.#aborts.set(manifest.appId, controller);
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const policy = manifest.prepare;
    const wantCompile = (options.stage ?? policy.furthestStage) === 'compile' && policy.furthestStage === 'compile';
    const supportsCompile = (adapter.supports ?? ['fetch']).includes('compile');
    const compile = wantCompile && supportsCompile;

    const budget = new Budget({
      maxBytes: Math.min(options.maxBytes ?? this.#defaults.maxBytes, policy.maxBytes),
      maxConcurrency: Math.min(options.maxConcurrency ?? this.#defaults.maxConcurrency, policy.maxConcurrency),
    });

    const items = adapter.plan(manifest);
    const caps = prepareCapabilities(this.#env, { signal: controller.signal, compile });
    const startedAt = this.#env.now();
    this.#telemetry.emit('prepare:start', { appId: manifest.appId, releaseId: manifest.releaseId, items: items.length, stage: compile ? 'compile' : 'fetch' });

    if (options.hints !== false) emitHints(this.#env, manifest, items);

    const prepareAsset = adapter.prepareAsset ?? defaultPrepareAsset;
    const values = new Map();
    const { prepared, skipped } = await spend(
      items,
      budget,
      async (item) => {
        const value = await prepareAsset(caps, item, `${manifest.baseUrl}${item.path}`);
        values.set(item.path, value);
        return value;
      },
      { signal: controller.signal },
    );

    const receipt = Object.freeze({
      appId: manifest.appId,
      releaseId: manifest.releaseId,
      stage: compile ? 'compile' : 'fetch',
      bytes: budget.spent,
      prepared: prepared.map((p) => p.item.path),
      skipped: skipped.map((s) => ({ path: s.item.path, reason: s.reason })),
      values,
      startedAt,
      finishedAt: this.#env.now(),
      cancelled: controller.signal.aborted,
    });
    this.#preparations.set(manifest.appId, receipt);
    this.#aborts.delete(manifest.appId);
    this.#telemetry.emit('prepare:done', {
      appId: receipt.appId,
      releaseId: receipt.releaseId,
      bytes: receipt.bytes,
      prepared: receipt.prepared.length,
      skipped: receipt.skipped.length,
      ms: receipt.finishedAt - receipt.startedAt,
      cancelled: receipt.cancelled,
    });
    return receipt;
  }

  /** Cancel in-flight preparation for an app. Activation afterwards is still correct. */
  cancel(appId) {
    const controller = this.#aborts.get(appId);
    if (!controller) return false;
    controller.abort();
    this.#telemetry.emit('prepare:cancelled', { appId });
    return true;
  }

  /**
   * Start (or reuse) the application in this document.
   *
   * Idempotent per (app, release) within the document: concurrent callers — several islands
   * appearing at once, a click racing a hover — share one initialization.
   */
  activate(appId, options = {}) {
    const manifest = this.#registry.get(appId);
    const key = `${appId}@${manifest.releaseId}`;

    const running = this.#instances.get(key);
    if (running && !options.force) return Promise.resolve(running);

    const existing = this.#inFlightActivate.get(key);
    if (existing) return existing;

    const promise = this.#activate(manifest, key, options).finally(() => {
      this.#inFlightActivate.delete(key);
    });
    this.#inFlightActivate.set(key, promise);
    return promise;
  }

  async #activate(manifest, key, options) {
    const adapter = this.#adapterFor(manifest);
    const startedAt = this.#env.now();
    this.#telemetry.emit('activate:start', { appId: manifest.appId, releaseId: manifest.releaseId });

    // Preparation from a superseded release is discarded, never mixed into this activation.
    let prepared = this.preparationOf(manifest.appId);
    if (prepared && prepared.releaseId !== manifest.releaseId) {
      this.#telemetry.emit('activate:stale-preparation', {
        appId: manifest.appId,
        prepared: prepared.releaseId,
        current: manifest.releaseId,
      });
      this.#preparations.delete(manifest.appId);
      prepared = null;
    }

    const caps = activateCapabilities(this.#env, {
      signal: options.signal,
      host: options.host ?? null,
      prepared: prepared?.values ?? new Map(),
    });

    const instance = await adapter.activate(caps, manifest, options);
    this.#instances.set(key, instance);
    this.#telemetry.emit('activate:done', {
      appId: manifest.appId,
      releaseId: manifest.releaseId,
      reusedPreparation: Boolean(prepared),
      ms: this.#env.now() - startedAt,
    });
    return instance;
  }

  /** Tear an activated application down (a persistent shell removing a view, say). */
  async deactivate(appId) {
    const manifest = this.#registry.get(appId);
    const key = `${appId}@${manifest.releaseId}`;
    const instance = this.#instances.get(key);
    if (!instance) return false;
    const adapter = this.#adapterFor(manifest);
    if (adapter.deactivate) await adapter.deactivate(instance);
    this.#instances.delete(key);
    this.#telemetry.emit('deactivate', { appId, releaseId: manifest.releaseId });
    return true;
  }
}

/** Convenience constructor: `createCoordinator({ env, validate, adapters })`. */
export function createCoordinator(options) {
  return new Coordinator(options);
}
