# Agents Test Performance

Agent tests are often import-bound. Treat slow test files as architecture
signals, not just runner noise.

## Guardrails

- Benchmark before and after performance edits. Prefer existing grouped
  artifacts when comparing suites, or use `/usr/bin/time -l pnpm test <file>`
  for a scoped hotspot.
- If a test only needs schema, capability, routing, or static discovery data,
  do not cold-load full bundled plugin/channel/provider runtime. Add or reuse a
  lightweight typed artifact and keep full runtime as a fallback.
- Keep expensive bootstrap, embedded runner, provider, plugin, and channel
  runtime work behind dependency injection or narrow helpers so tests can cover
  behavior without starting the whole runtime.
- Treat channel/plugin lookups inside agent hot paths as suspect. If the code
  only needs target parsing, peer-kind inference, setup hints, or static
  descriptors, use a local pure helper or lightweight public artifact before
  reaching for `getChannelPlugin()` / bundled runtime fallback.
- In spawn/session/requester-origin logic, keep routing and delivery-context
  normalization deterministic and runtime-free. Add explicit parser coverage for
  channel-specific prefixes instead of loading a channel plugin just to classify
  a target.
- If moving coverage out of a slow integration test, preserve the exact
  production composition in a named helper and test that helper. Do not remove
  the behavior proof just because the old proof was slow.
- Avoid broad `importOriginal()` partial mocks and module resets in hot agent
  tests. Use explicit mock factories, one-time imports, and reset only the
  state the test mutates.

## Verification

- For agent performance changes, record seconds and RSS before/after in the
  handoff or benchmark report.
- If the change touches lazy-loading, plugin runtime imports, or bundled
  artifacts, run `pnpm build`.
