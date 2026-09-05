// The one guarantee the whole design rests on: preparation does not run the application.
//
// If this erodes, "warming the loader" quietly becomes "starting the app on the marketing
// page" — auth redirects from a page nobody clicked, database writes, live subscriptions,
// and analytics for sessions that never happened. So it is tested two ways: structurally
// (what preparation can even reach) and lexically (what the adapters in this org's source
// are allowed to mention inside their prepare path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createCoordinator } from '../index.mjs';
import { interfaces, manifests, testEnv } from './helpers.mjs';
import { recordingAdapter } from './recording-adapter.mjs';

const validate = (m) => interfaces.checkManifest(m, interfaces.manifestSchema);

test('preparation capabilities expose fetching and nothing else', async () => {
  const adapter = recordingAdapter('leptos');
  const env = testEnv();
  const coordinator = createCoordinator({ env, validate, adapters: [adapter] });
  coordinator.register(manifests.leptos);
  await coordinator.prepare('owl-fixture-leptos');

  assert.ok(adapter.calls.prepareCaps.length > 0);
  for (const caps of adapter.calls.prepareCaps) {
    assert.deepEqual(Object.keys(caps).sort(), ['compileStreaming', 'fetch', 'log', 'signal']);
    assert.equal(caps.document, undefined, 'preparation must not receive a document');
    assert.equal(caps.window, undefined);
    assert.equal(caps.host, undefined);
    assert.equal(caps.wasm, undefined, 'only the narrow compileStreaming capability, never all of WebAssembly');
    assert.ok(Object.isFrozen(caps), 'capabilities must not be extendable by an adapter');
  }
});

test('activation — and only activation — receives the page', async () => {
  const adapter = recordingAdapter('leptos');
  const env = testEnv();
  const coordinator = createCoordinator({ env, validate, adapters: [adapter] });
  coordinator.register(manifests.leptos);
  await coordinator.activate('owl-fixture-leptos', { host: { id: 'root' } });

  const [caps] = adapter.calls.activateCaps;
  assert.ok(caps.document, 'activation owns the document');
  assert.deepEqual(caps.host, { id: 'root' });
});

test('compileStreaming is offered only when the release policy and the runtime both allow it', async () => {
  const compiled = [];
  const wasm = { compileStreaming: async (r) => { compiled.push(r.url); return { fake: 'module' }; } };

  // leptos fixture: furthestStage=compile, runtime offers WebAssembly -> capability present.
  const withWasm = recordingAdapter('leptos');
  const a = createCoordinator({ env: testEnv({ wasm }), validate, adapters: [withWasm] });
  a.register(manifests.leptos);
  await a.prepare('owl-fixture-leptos');
  assert.ok(withWasm.calls.prepareCaps.every((c) => typeof c.compileStreaming === 'function'));

  // Same release, runtime without WebAssembly -> no capability, preparation still succeeds.
  const noWasm = recordingAdapter('leptos');
  const b = createCoordinator({ env: testEnv({ wasm: null }), validate, adapters: [noWasm] });
  b.register(manifests.leptos);
  const receipt = await b.prepare('owl-fixture-leptos');
  assert.ok(noWasm.calls.prepareCaps.every((c) => c.compileStreaming === null));
  assert.ok(receipt.prepared.length > 0);

  // A flutter release may not reach the compile stage at all: its bootstrap owns compilation.
  const flutter = recordingAdapter('flutter');
  const c = createCoordinator({ env: testEnv({ wasm }), validate, adapters: [flutter] });
  c.register(manifests.flutter);
  const flutterReceipt = await c.prepare('owl-fixture-flutter', { stage: 'compile' });
  assert.equal(flutterReceipt.stage, 'fetch');
  assert.ok(flutter.calls.prepareCaps.every((cap) => cap.compileStreaming === null));
});

test('an adapter that only declares fetch never gets a compile capability', async () => {
  const fetchOnly = { ...recordingAdapter('leptos'), supports: ['fetch'] };
  const wasm = { compileStreaming: async () => ({}) };
  const coordinator = createCoordinator({ env: testEnv({ wasm }), validate, adapters: [fetchOnly] });
  coordinator.register(manifests.leptos);
  const receipt = await coordinator.prepare('owl-fixture-leptos');
  assert.equal(receipt.stage, 'fetch');
});

// ---------------------------------------------------------------------------
// Lexical gate over this org's source: nothing on a prepare path may mention a
// construct that could execute application code.
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  [/\bdocument\.createElement\(\s*['"]script['"]/, 'inserts a script element'],
  [/\bimport\s*\(/, 'dynamically imports a module'],
  [/\beval\s*\(/, 'evaluates code'],
  [/new\s+Function\s*\(/, 'builds a function from source'],
  [/\bimportScripts\s*\(/, 'imports scripts into a worker'],
  [/WebAssembly\.instantiate/, 'instantiates a module (that is activation, not preparation)'],
];

/** Extract the body of every function whose name marks it as part of preparation. */
function preparePathSources(file) {
  const text = readFileSync(file, 'utf8');
  const out = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w*[Pp]repare\w*)\s*\(|(?:async\s+)?(prepareAsset|plan)\s*\(/g;
  for (const m of text.matchAll(re)) {
    const start = text.indexOf('{', m.index + m[0].length - 1);
    if (start < 0) continue;
    let depth = 0;
    let i = start;
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({ name: m[1] ?? m[2], body: text.slice(start, i + 1) });
  }
  return out;
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return entry === 'node_modules' || entry === '.vendor' ? [] : sourceFiles(p);
    return p.endsWith('.mjs') && !p.includes('/test/') ? [p] : [];
  });
}

test('no prepare path in this org executes anything', () => {
  const orgRoot = join(new URL('.', import.meta.url).pathname, '..', '..');
  const packages = ['owl-coordinator', 'owl-rust-loader', 'owl-flutter-loader'].filter((p) => existsSync(join(orgRoot, p)));
  assert.ok(packages.includes('owl-coordinator'));

  const findings = [];
  let scanned = 0;
  for (const pkg of packages) {
    for (const file of sourceFiles(join(orgRoot, pkg))) {
      for (const fn of preparePathSources(file)) {
        scanned += 1;
        for (const [pattern, why] of FORBIDDEN) {
          if (pattern.test(fn.body)) findings.push(`${pkg}/${file.split(`${pkg}/`)[1]}: ${fn.name}() ${why}`);
        }
      }
    }
  }
  assert.ok(scanned >= 2, `expected to scan prepare paths, scanned ${scanned}`);
  assert.deepEqual(findings, [], `preparation must not execute application code:\n  ${findings.join('\n  ')}`);
});
