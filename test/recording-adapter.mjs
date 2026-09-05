import { interfaces } from './helpers.mjs';

/** A minimal adapter over the real interfaces plan, recording what it was asked to do. */
export function recordingAdapter(framework, overrides = {}) {
  const calls = { plan: 0, activate: 0, deactivate: 0, prepareCaps: [], activateCaps: [] };
  return {
    calls,
    framework,
    supports: ['fetch', 'compile'],
    plan(manifest) {
      calls.plan += 1;
      return interfaces.preparableAssets(manifest);
    },
    async prepareAsset(caps, item, url) {
      calls.prepareCaps.push(caps);
      const response = await caps.fetch(url, { signal: caps.signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      await response.arrayBuffer();
      return { kind: 'bytes', bytes: item.bytes };
    },
    async activate(caps, manifest, options) {
      calls.activate += 1;
      calls.activateCaps.push(caps);
      return { appId: manifest.appId, releaseId: manifest.releaseId, host: options.host ?? null, reused: caps.prepared.size };
    },
    async deactivate() {
      calls.deactivate += 1;
    },
    ...overrides,
  };
}
