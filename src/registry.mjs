// The release registry: which release of which app this document is allowed to prepare and
// activate, and the guarantee that a single release is used end to end.
//
// The failure this exists to prevent: a marketing page prepares release A, the CDN publishes
// release B while the visitor reads, and activation mixes A's bootstrap with B's module. The
// symptoms of that are import mismatches and hydration corruption, so it is refused outright.

export class ReleaseMismatchError extends Error {
  constructor(appId, prepared, current) {
    super(`app ${appId}: prepared release ${prepared} but ${current} is now current — preparation is discarded rather than mixed`);
    this.name = 'ReleaseMismatchError';
    this.appId = appId;
    this.prepared = prepared;
    this.current = current;
  }
}

export class Registry {
  #entries = new Map();
  #validate;

  /** @param validate a manifest checker returning a list of errors (owl-interfaces' checkManifest). */
  constructor({ validate }) {
    this.#validate = validate;
  }

  /** Register (or replace) the current manifest for an app. Invalid manifests are refused. */
  register(manifest) {
    const errors = this.#validate(manifest);
    if (errors.length) {
      throw new Error(`refusing manifest for ${manifest?.appId ?? '<unknown>'}:\n  ${errors.join('\n  ')}`);
    }
    this.#entries.set(manifest.appId, manifest);
    return manifest;
  }

  has(appId) {
    return this.#entries.has(appId);
  }

  get(appId) {
    const m = this.#entries.get(appId);
    if (!m) throw new Error(`unknown app \`${appId}\`: register its manifest before preparing or activating it`);
    return m;
  }

  get apps() {
    return [...this.#entries.keys()];
  }

  /** Fetch a manifest and register it. The only network call the registry itself makes. */
  async load(url, { fetch, signal } = {}) {
    const response = await fetch(url, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`manifest ${url}: HTTP ${response.status}`);
    return this.register(await response.json());
  }

  /** Throws unless the release recorded at preparation time is still the current one. */
  assertSameRelease(appId, preparedReleaseId) {
    const current = this.get(appId).releaseId;
    if (preparedReleaseId && preparedReleaseId !== current) {
      throw new ReleaseMismatchError(appId, preparedReleaseId, current);
    }
    return current;
  }
}
