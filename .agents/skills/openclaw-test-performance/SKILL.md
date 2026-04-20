---
name: openclaw-test-performance
description: Benchmark, diagnose, and optimize OpenClaw test performance without losing coverage. Use when Codex needs to reassess `pnpm test`, compare grouped Vitest reports, identify CPU/memory/import hotspots, fix slow tests or cold runtime paths, preserve behavior proofs, update the performance report, add AGENTS guardrails, and make scoped commits/pushes for OpenClaw test-speed work.
---

# OpenClaw Test Performance

Use evidence first. The goal is real `pnpm test` speed/RSS improvement with
coverage intact, not runner tuning by guesswork.

## Workflow

1. Read the relevant local `AGENTS.md` files before editing:
   - `src/agents/AGENTS.md` for agent/import hotspots.
   - `src/channels/AGENTS.md` and `src/plugins/AGENTS.md` for plugin/channel
     laziness.
   - `src/gateway/AGENTS.md` for server lifecycle tests.
   - `test/helpers/AGENTS.md` and `test/helpers/channels/AGENTS.md` for shared
     contract helpers.
   - `src/infra/outbound/AGENTS.md` for outbound/media/action tests.
2. Establish a baseline before changing code:
   - Prefer `pnpm test:perf:groups --full-suite --allow-failures --output <file>`
     for full-suite ranking.
   - For a scoped hotspot use:
     `/usr/bin/time -l pnpm test <file-or-files> --maxWorkers=1 --reporter=verbose`
   - For import-heavy suspicion add:
     `OPENCLAW_VITEST_IMPORT_DURATIONS=1 OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN=1`.
3. Separate wall/runner noise from real file cost:
   - Compare Vitest duration, test body timing, import breakdown, wall time, and
     max RSS.
   - Re-run single files when grouped/full-suite numbers look stale or noisy.
   - If a full-suite grouped run reports a lane failure but JSON says tests
     passed, capture that as harness/noise and verify the suspect file directly.
4. Pick the next attack by return and risk:
   - High return: one file/test dominates seconds or RSS and has a clear root.
   - Lower risk: static descriptors, target parsing, routing, auth bypass,
     setup hints, registry fixtures, or test server lifecycle.
   - Higher risk: real memory/runtime behavior, live providers, protocol
     contracts, or broad production refactors.
5. Fix the root cause, not the symptom:
   - Move static metadata/parsing into narrow helpers or lightweight artifacts
     reused by full runtime and fast paths.
   - Prefer dependency injection, loaded-plugin-only lookup, explicit fixtures,
     and pure helpers over broad mocks.
   - Reuse suite-level servers/clients when a fresh handshake is irrelevant.
   - Keep schedulers/background loops off unless the test proves scheduling.
6. Preserve coverage shape:
   - Do not delete a slow integration proof unless the exact production
     composition is extracted into a named helper and tested.
   - Keep one cheap integration smoke when cross-component wiring matters.
   - State explicitly what incidental coverage was removed, if any.
7. Re-benchmark the same command after the change and compute seconds plus
   percent gain.
8. Update the running report when requested or when this thread is tracking one.
   Include before/after commands, artifacts, coverage notes, verification, and
   next attack order.
9. Commit with `scripts/committer "<message>" <paths...>` and push when the
   user asked for commits/pushes. Stage only files touched for this attack.

## Common Root Causes

- Full bundled channel/plugin runtime loaded for static data.
- `getChannelPlugin()` fallback used when an already-loaded fixture or pure
  parser would suffice.
- Broad `api.ts`, `runtime-api.ts`, `test-api.ts`, or plugin-sdk barrels pulled
  into hot tests.
- Partial-real mocks using `importActual()` around broad modules.
- `vi.resetModules()` plus fresh imports in per-test loops.
- Test plugin registry seeded in `beforeAll` while runtime state resets in
  `afterEach`.
- Per-test gateway/server/client startup when state reset would suffice.
- Runtime/default model/auth selection paid by idle snapshots or fixtures.
- Plugin-owned media/action discovery triggered before checking whether args
  contain plugin-owned fields.

## Benchmark Commands

Scoped file:

```bash
timeout 240 /usr/bin/time -l pnpm test <file> --maxWorkers=1 --reporter=verbose
```

Scoped file with import breakdown:

```bash
timeout 240 /usr/bin/time -l env \
  OPENCLAW_VITEST_IMPORT_DURATIONS=1 \
  OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN=1 \
  pnpm test <file> --maxWorkers=1 --reporter=verbose
```

Grouped suite:

```bash
pnpm test:perf:groups --full-suite --allow-failures \
  --output .artifacts/test-perf/<name>.json
```

Reuse an existing Vitest JSON report:

```bash
pnpm test:perf:groups --report <vitest-json> \
  --output .artifacts/test-perf/<name>.json
```

## Verification

- Always run the targeted test surface that proves the change.
- Run `pnpm check` before commit unless the change is docs-only and the hook
  handles it.
- Run `pnpm build` when touching lazy-loading, bundled artifacts, package
  boundaries, dynamic imports, build output, or public surfaces.
- If deps are missing/stale, run `pnpm install` and retry the exact failed
  command once.
- Use the report format:

```markdown
| Metric         | Before | After |          Gain |
| -------------- | -----: | ----: | ------------: |
| File wall time |   `Xs` |  `Ys` |  `-Zs` (`P%`) |
| Max RSS        |  `XMB` | `YMB` | `-ZMB` (`P%`) |
```

## Handoff

Keep the final concise:

- Root cause.
- Files changed.
- Before/after numbers.
- Coverage retained.
- Verification commands.
- Commit hash and push status.
