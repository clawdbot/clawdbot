# Temporary dependency patches

Keep existing insertion anchors when extending these patches: pnpm 12 can apply a zero-context, zero-length insertion one line early. After regeneration and installation, verify installed files against the patch's target blob hashes before testing.

`@novnc/novnc@1.7.0` has an approved temporary patch for ignored extended-clipboard payloads. The RFB owner consumes the remaining compressed bytes before returning for view-only clients or unsupported clipboard formats. It does not inflate or publish ignored clipboard data, and controlling text clipboard handling stays unchanged. This keeps clipboard bytes from becoming the next RFB message and disconnecting WebVNC.

Remove the noVNC patch, its registration, and its exact-version guard exception when an upstream version passes the Desktop panel and document browser suites (`test/vitest/vitest.ui-e2e.config.ts`) and the live view-only selection/type stress check. The regression uses the real noVNC parser, covers coalesced and fragmented payload delivery, and requires the next framebuffer update without a reconnect.

`matrix-js-sdk@42.2.0` has an approved temporary patch for saved-sync verification replay. Classic sync propagates its existing cache provenance through ordinary client events, and the crypto listener ignores restored events. This preserves room history, sync cursors, ordinary event listeners, fresh verification events, and to-device processing while preventing cached verification requests from restarting after a clean client shutdown.

Remove the Matrix patch, its registration, and its exact-version guard exception when an upstream release passes `node scripts/run-vitest.mjs extensions/matrix/src/matrix/client/file-sync-store.sdk.test.ts` and the full Matrix QA catalog, including the original DM SAS-to-QR sequence. The regression exercises the real SQLite sync store, SDK cache hydration, and crypto event wiring; it observes crypto input rather than substituting for native verification proof.

`vitest@5.0.0` has one approved exact-version pnpm patch. Vitest 5 bundles the
runner, and `@vitest/runner@5.0.0` is not published, so no standalone runner
dependency or patch remains. The published package integrity is
`sha512-gpsMNoRhMjMktVxPtstOH4/PJuPyovVaMDr4oDilXaGH1EcqM2OE96SoHT2VIQ6fTGtTjqmHDrEu2X9RQiXf8Q==`.
The patch SHA-256 is
`76a69c6de8bc85bb68eebebddf7e1e798a4ebf46d36ad60e6447ebc62c49f702`
and it changes exactly these seven published files:

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/chunks/cac.D805sv8h.js` | `a0971660b8c52884366a1ca3dceb6a7eb7ff41e2e3cfaed27b98395ed054e1d0` | `f37acc539be54a668448c9ae1faeacc4b37df68f81952a21001c377a775da55e` |
| `dist/chunks/index.B89dZ0-N.js` | `7ae1406d3a808a5a2915895eede01e4e79fac5838f5a6457adbffd78df1bf56d` | `54a978632cf3584e4507bed3f09ba22d6f344ec45bac5ea37fda0b9718b59e58` |
| `dist/chunks/index.OVGXnVRj.js` | `57c89e884bab20623afc06a58119c70c4f2e06397ae63e961ad0a0810c9a94b5` | `c4b8a1c9f865c4719d1bf01d871d89fd405b9a3141f2ef9bc9690e1d5078d0a8` |
| `dist/chunks/init-forks.CiCtIMPj.js` | `ef8cf8283d7b420d2fae017b8f284555ed67e207ea12fa9f53ab28421168adfc` | `ce9b827f016907bd054c9c8041e70db67ba28943c13a0b66b8551b5b51f1fafa` |
| `dist/chunks/plugin.d.BbcoZhuj.d.ts` | `fc8d53b3329bf55bc3dba0709c2280e997a860d2b45189589f43ea21b4076087` | `9409856e49fb8b6b9a84725340c7f68af76dc5c35e237ba7da71e5534d22e54c` |
| `dist/chunks/run.CQOUYP-x.js` | `8aa94c491fc34a880fdcaaea493fdba5d05affd8e5be68bb7a70c6ebe74ddf63` | `1d424d73af1e301188789e2b82a28cde2e037998a7d995a5374dfc36c352fe99` |
| `dist/node.d.ts` | `2b82496067d8e4387e08f4902a8f81718f1ba5b2504097c6c7d05b420ea18f63` | `d09c5c26f971a500cc8f34a5c5a29eafca3988e13f42408ef91b488702aa6305` |

The patch owns these temporary invariants and removal gates:

- **CLI validation (`cac.D805sv8h.js`):** public `parseCLI` validates unknown
  options, required values, and required arguments without executing a command.
  Help/version and `allowUnknownOptions` retain native semantics. Remove this
  hunk when stock Vitest passes the native validation cases in
  `test/scripts/run-vitest-profile.test.ts` and
  `test/scripts/vitest-report-owner.test.ts`.
- **Filesystem cache generations (`index.B89dZ0-N.js`):** persistence remains
  disabled until lockfile integrity completes; generation participates in cache
  keys; lock transitions rewrite metadata and reset retained roots, keys, and
  transform temporary markers; invalidation covers the root and selected
  projects. Remove these hunks when stock Vitest passes the four cache-generation
  and invalidation regressions in `test/vitest-performance-config.test.ts`.
- **Graceful fork shutdown (`index.B89dZ0-N.js`,
  `init-forks.CiCtIMPj.js`, `plugin.d.BbcoZhuj.d.ts`, `dist/node.d.ts`):**
  built-in fork workers flush a `willExit` response, exit explicitly, and are
  joined before run completion. Deadline and abnormal-exit paths still fail and
  terminate the worker; custom transports remain parent-owned unless they opt
  into the contract. Remove these hunks when stock Vitest passes
  `test/scripts/vitest-fork-shutdown.test.ts`,
  `test/scripts/run-vitest-state-cleanup.test.ts`, and
  `test/scripts/run-vitest-profile.test.ts`.
- **File-backed report projects (`index.B89dZ0-N.js`,
  `plugin.d.BbcoZhuj.d.ts`):** a Vitest-owned
  `{ config, root?, namePrefix? }` descriptor loads its config exactly once,
  keeps the file-owned root when omitted, preserves the explicit root when
  supplied, and derives its final name after Vite hooks. A replayed prefix
  retains the container-owned identity and marks the executed config as a
  standalone project so its children are not rediscovered. Remove these hunks
  when stock Vitest passes
  `test/scripts/vitest-report-owner.test.ts` without pre-resolving configs or
  injecting captured names and `test/vitest-ui-package-config.test.ts` without
  losing omitted or explicit project roots.
- **Trailing task updates (`run.CQOUYP-x.js`):** the bundled runner accepts the
  exact batching deadline and clears a consumed timer before re-entering the
  throttle, so an early callback can rearm without losing the trailing update.
  Remove this hunk when stock Vitest passes
  `test/scripts/vitest-runner-task-updates.test.ts`.
- **Fake timer heap order (`index.OVGXnVRj.js`):** refresh removes a timer from
  the heap before mutating its ordering key, then reinserts it. Remove this hunk
  when stock Vitest passes `test/scripts/vitest-fake-timers.test.ts` and
  `extensions/telegram/src/probe.response-body-timeout.test.ts`.

Generate and register dependency patches through pnpm; never edit installed
dependency files manually. A clean `pnpm install --frozen-lockfile` must apply
the recorded patch hash to the published integrity and reproduce every patched
target hash above.

Stable Vitest 5.0.0 packages were published on September 3, 2026. The latest
package in the pinned family, `@vitest/browser@5.0.0`, was published at
12:24:37.187 UTC, so the exact family cooldown exclusions in
`pnpm-workspace.yaml` remain required until September 10, 2026 at
12:24:37.187 UTC.
