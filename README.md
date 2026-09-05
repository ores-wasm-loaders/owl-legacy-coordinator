# owl-coordinator

The browser coordinator: the framework-independent half of the loading layer — release registry, prepare-vs-activate split, byte and concurrency budgets, request de-duplication, cancellation, intent policy and telemetry.

Part of [`ores-wasm-loaders`](https://github.com/ores-wasm-loaders) — the org that owns the fleet's shared
web-loading layer for the 35+ marketing sites and their applications. Its sibling
[`ores-wasm-loaders-test`](https://github.com/ores-wasm-loaders-test) carries the external-facing test surface.

## What this org is for

Marketing sites are HTML-first and cheap. The applications behind them are not: a Flutter
web release or a Leptos/Dioxus island bundle costs a download, a compile and an
initialization before it is useful. This org shares the *loading and integration
infrastructure* across every product — one coordinator, one Flutter adapter, one Rust
adapter family, one manifest contract — so the expensive part is prepared while the visitor
is still reading, and so 80–90% of that plumbing is written once rather than 35 times.

It deliberately does **not** claim to share application bytes, application memory, or a
running runtime across a normal navigation. See `owl-docs/docs/architecture.md`.

## Depends on (zed-pkg)

- `ores-wasm-loaders/owl-interfaces`

## Shared building blocks

| Concern | Repo |
| --- | --- |
| Auth (OAuth, SAML, SCIM, RBAC) | github.com/shared-auth |
| Cross-device sync | github.com/opto-sync |
| Logging / telemetry | github.com/ores-otel |
| Feature flags | github.com/flags-2-env |
| Packages | github.com/zed-pkg |
| Web ⇄ API transport | github.com/ORESoftware/ores-transport |
| Locks and leases | github.com/ORESoftware/ores-locks-and-leases |
| TypeSpec + JSON Schema parity | github.com/ORESoftware/ores-contracts |
| Reusable GitHub workflows | github.com/ORESoftware/ores-gha-workflows |
| Edge failover | github.com/ORESoftware/ores-edge-router |

## Conventions for this repository

- `prepare()` must never execute application code: no script insertion, no dynamic import of an entrypoint, no auth, no writes. `test/no-execution.test.mjs` asserts this against every adapter registered in the fleet.
- Every effect (fetch, document, WebAssembly, idle scheduling) is injected through an environment object, so the whole coordinator is testable without a browser and cannot reach an ambient global by accident.
- State is per-document. A normal navigation does not carry a running app to the next page; only a persistent shell does. Do not document or imply otherwise.

## Tests

```sh
node --test test/*.test.mjs
```

No third-party dependencies: the whole org builds and tests offline, because it has to run
in every product org's CI before anything else is installed.
