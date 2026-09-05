import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoordinator, ReleaseMismatchError } from '../index.mjs';
import { interfaces, manifests, testEnv, fakeDocument } from './helpers.mjs';
import { recordingAdapter } from './recording-adapter.mjs';

const validate = (m) => interfaces.checkManifest(m, interfaces.manifestSchema);
const make = (envOptions = {}, adapters = [recordingAdapter('leptos')]) => {
  const env = testEnv(envOptions);
  const coordinator = createCoordinator({ env, validate, adapters });
  return { env, coordinator, adapter: adapters[0] };
};

test('an invalid manifest is refused at registration, not at click time', () => {
  const { coordinator } = make();
  assert.throws(() => coordinator.register({ ...manifests.leptos, appId: 'Not Valid' }), /refusing manifest/);
  assert.throws(() => coordinator.prepare('nope'), /unknown app/);
});

test('preparation fetches the release under its own budget and reports what it skipped', async () => {
  const { coordinator, env } = make();
  coordinator.register(manifests.leptos);
  const receipt = await coordinator.prepare('owl-fixture-leptos');

  assert.equal(receipt.appId, 'owl-fixture-leptos');
  assert.equal(receipt.releaseId, manifests.leptos.releaseId);
  assert.ok(receipt.prepared.length >= 2, 'entrypoints should be prepared');
  assert.ok(env.requests.every((r) => r.credentials === 'omit'), 'preparation must be credentialless');
  assert.ok(receipt.bytes <= manifests.leptos.prepare.maxBytes);
  // Lazy assets are never prepared.
  assert.equal(receipt.prepared.filter((p) => p.includes('lazy')).length, 0);
});

test('the budget truncates rather than overrunning, and says so', async () => {
  const { coordinator } = make({}, [recordingAdapter('leptos'), recordingAdapter('flutter')]);
  coordinator.register(manifests.flutter);
  const receipt = await coordinator.prepare('owl-fixture-flutter', { maxBytes: 100_000 });
  assert.ok(receipt.bytes <= 100_000, `spent ${receipt.bytes}`);
  assert.ok(receipt.skipped.some((s) => s.reason === 'over-budget'));
  assert.ok(receipt.skipped.length > 0);
});

test('concurrent prepare calls share one operation', async () => {
  const { coordinator, env } = make({ latencyMs: 5 });
  coordinator.register(manifests.leptos);
  const [a, b, c] = await Promise.all([
    coordinator.prepare('owl-fixture-leptos'),
    coordinator.prepare('owl-fixture-leptos'),
    coordinator.prepare('owl-fixture-leptos'),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  const unique = new Set(env.requests.map((r) => r.url));
  assert.equal(unique.size, env.requests.length, 'no asset should be fetched twice');
});

test('cancelling preparation leaves activation correct', async () => {
  const { coordinator, adapter } = make({ latencyMs: 50 });
  coordinator.register(manifests.leptos);
  const pending = coordinator.prepare('owl-fixture-leptos');
  assert.equal(coordinator.cancel('owl-fixture-leptos'), true);
  const receipt = await pending;
  assert.equal(receipt.cancelled, true);

  const instance = await coordinator.activate('owl-fixture-leptos', { host: {} });
  assert.equal(instance.appId, 'owl-fixture-leptos');
  assert.equal(adapter.calls.activate, 1);
});

test('activation works with no preparation at all (cold entry)', async () => {
  const { coordinator, adapter } = make();
  coordinator.register(manifests.dioxus);
  coordinator.use(recordingAdapter('dioxus'));
  const instance = await coordinator.activate('owl-fixture-dioxus', { host: {} });
  assert.equal(instance.releaseId, manifests.dioxus.releaseId);
  assert.equal(adapter.calls.activate, 0, 'the leptos adapter must not have been used');
});

test('activation is idempotent per (app, release) within the document', async () => {
  const { coordinator, adapter } = make();
  coordinator.register(manifests.leptos);
  const [x, y] = await Promise.all([
    coordinator.activate('owl-fixture-leptos', { host: {} }),
    coordinator.activate('owl-fixture-leptos', { host: {} }),
  ]);
  assert.equal(x, y);
  const z = await coordinator.activate('owl-fixture-leptos', { host: {} });
  assert.equal(z, x);
  assert.equal(adapter.calls.activate, 1, 'one initialization, however many callers');
});

test('a release published mid-visit discards stale preparation instead of mixing', async () => {
  const { coordinator } = make();
  coordinator.register(manifests.leptos);
  const receipt = await coordinator.prepare('owl-fixture-leptos');
  assert.equal(receipt.prepared.length > 0, true);

  const events = [];
  coordinator.on('activate:stale-preparation', (e) => events.push(e));
  coordinator.register({ ...manifests.leptos, releaseId: '2026.09.06-newrelease', baseUrl: '/releases/owl-fixture-leptos/2026.09.06-newrelease/' });

  const instance = await coordinator.activate('owl-fixture-leptos', { host: {} });
  assert.equal(instance.releaseId, '2026.09.06-newrelease');
  assert.equal(instance.reused, 0, 'nothing from the old release may be handed to the new one');
  assert.equal(events.length, 1);
  assert.equal(events[0].prepared, manifests.leptos.releaseId);
});

test('the registry refuses to mix releases when asked directly', () => {
  const { coordinator } = make();
  coordinator.register(manifests.leptos);
  assert.equal(coordinator.registry.assertSameRelease('owl-fixture-leptos', manifests.leptos.releaseId), manifests.leptos.releaseId);
  assert.throws(() => coordinator.registry.assertSameRelease('owl-fixture-leptos', 'older'), ReleaseMismatchError);
});

test('preparation emits prefetch hints once per asset, never duplicated', async () => {
  const document = fakeDocument();
  const { coordinator } = make({ document });
  coordinator.register(manifests.leptos);
  await coordinator.prepare('owl-fixture-leptos');
  const before = document.head.children.length;
  assert.ok(before > 0, 'expected prefetch links');
  assert.ok(document.head.children.every((l) => l.rel === 'prefetch' && l.crossOrigin === 'anonymous'));
  await coordinator.prepare('owl-fixture-leptos', { force: true });
  assert.equal(document.head.children.length, before, 'hints must be idempotent');
});

test('telemetry records the whole lifecycle', async () => {
  const { coordinator } = make();
  coordinator.register(manifests.leptos);
  const seen = [];
  coordinator.on('*', (e) => seen.push(e.event));
  await coordinator.prepare('owl-fixture-leptos');
  await coordinator.activate('owl-fixture-leptos', { host: {} });
  await coordinator.deactivate('owl-fixture-leptos');
  assert.deepEqual(seen, ['prepare:start', 'prepare:done', 'activate:start', 'activate:done', 'deactivate']);
  assert.throws(() => coordinator.on('prepare:whatever', () => {}), /unknown loader event/);
});

test('a failed asset is a non-event: preparation reports it and activation still runs', async () => {
  const { coordinator } = make({ fail: new Set(['islands_bg.wasm']) });
  coordinator.register(manifests.leptos);
  const receipt = await coordinator.prepare('owl-fixture-leptos');
  assert.ok(receipt.skipped.some((s) => s.path === 'islands_bg.wasm' && s.reason === 'failed'));
  const instance = await coordinator.activate('owl-fixture-leptos', { host: {} });
  assert.ok(instance);
});

test('an unknown framework fails loudly at prepare time, naming what is registered', async () => {
  const { coordinator } = make();
  coordinator.register(manifests.flutter);
  await assert.rejects(() => coordinator.prepare('owl-fixture-flutter'), /no adapter registered for framework `flutter`.*leptos/s);
});
