// Resource hints.
//
// These are hints, not guarantees: the browser decides whether to act on them, when, and
// whether to keep the result. They are emitted alongside real preparation, never instead of
// it, and nothing downstream is allowed to assume a hint succeeded.
//
//   prefetch        best-effort preparation of a resource a LATER same-site navigation is
//                   likely to need. The right hint for "the app page will want this".
//   preload         a resource the CURRENT document needs soon. Not a future-page cache.
//   modulepreload   fetch and prepare a JS module for the CURRENT document's module map.
//                   It is not a cross-page module registry.
//
// Browser HTTP caches are partitioned by top-level site, so a hint issued on one org's
// marketing site does not warm another org's app on a different site — no matter that both
// pull from the same CDN. Emitting them is still worth it within a site.

const AS_FOR = {
  'application/wasm': 'fetch',
  'text/javascript': 'script',
  'application/javascript': 'script',
  'text/css': 'style',
  'font/otf': 'font',
  'font/ttf': 'font',
  'font/woff2': 'font',
};

/**
 * Emit `<link rel=prefetch>` for the release's critical files, once per document.
 * Silently does nothing in a headless environment.
 */
export function emitHints(env, manifest, items) {
  const doc = env.document;
  if (!doc?.head) return [];
  const emitted = [];
  for (const item of items) {
    if ((item.stage ?? 'critical') !== 'critical' && !item.role) continue;
    const href = `${manifest.baseUrl}${item.path}`;
    if (doc.querySelector?.(`link[rel="prefetch"][href="${href}"]`)) continue;
    const link = doc.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    link.as = AS_FOR[item.contentType] ?? 'fetch';
    // Prefetched bytes must be reusable by the app page's own credentialless requests.
    link.crossOrigin = 'anonymous';
    doc.head.appendChild(link);
    emitted.push(href);
  }
  return emitted;
}

/**
 * Speculation-rules prerender for the destination PAGE.
 *
 * This is the honest answer to "ready when we arrive": it prepares the destination's own
 * document rather than pretending the marketing page's runtime can be handed over. Support
 * and eligibility vary, so it is an enhancement — the click path must never depend on it.
 */
export function emitPrerenderRule(env, urls, { eagerness = 'moderate' } = {}) {
  const doc = env.document;
  if (!doc?.head) return false;
  if (!('supports' in HTMLScriptElement) || !HTMLScriptElement.supports?.('speculationrules')) return false;
  const script = doc.createElement('script');
  script.type = 'speculationrules';
  script.textContent = JSON.stringify({ prerender: [{ source: 'list', urls, eagerness }] });
  doc.head.appendChild(script);
  return true;
}
