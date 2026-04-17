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
