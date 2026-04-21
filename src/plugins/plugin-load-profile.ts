/**
 * Shared probe primitives for plugin-load profiling.
 *
 * All plugin-load probes — across `src/plugins/loader.ts`,
 * `src/plugins/source-loader.ts`, and `src/plugin-sdk/channel-entry-contract.ts`
 * — emit a single line per measurement to stderr in the form:
 *
 *     [plugin-load-profile] phase=<X> plugin=<Y> elapsedMs=<N> [extras…] source=<S>
 *
 * The same `OPENCLAW_PLUGIN_LOAD_PROFILE=1` env flag activates all probes.
 *
 * Tooling that scrapes these lines (e.g. PERF-STARTUP-PLAN.md profiling
 * methodology) depends on the field order being:
 *
 *   1. `phase=`
 *   2. `plugin=`
 *   3. `elapsedMs=`
 *   4. any caller-supplied extras (in declaration order)
 *   5. `source=` last
 *
 * Keep this contract stable — downstream parsers rely on it.
 */

export function shouldProfilePluginLoader(): boolean {
  return process.env.OPENCLAW_PLUGIN_LOAD_PROFILE === "1";
}

/**
 * An ordered list of `[key, value]` pairs appended between `elapsedMs=` and
 * `source=` on the emitted log line. Ordered tuples (not a record) so that
 * scrapers see a deterministic field order regardless of object iteration
 * quirks.
 */
export type PluginLoadProfileExtras = ReadonlyArray<readonly [string, number | string]>;

/** Per-call scope: which plugin and which source path the probe is for. */
export type PluginLoadProfileScope = {
  pluginId?: string;
  source: string;
};

/**
 * A scope-bound profiler — call it with a `phase` + sync `run` to time and
 * emit a `[plugin-load-profile]` line that already includes the bound
 * `pluginId` and `source`. Build one with `createProfiler(scope)`.
 */
export type PluginLoadProfiler = <T>(
  phase: string,
  run: () => T,
  extras?: PluginLoadProfileExtras,
) => T;

/**
 * Render a `[plugin-load-profile]` line. Exported so that callers needing
 * custom timing splits (e.g. dual-timer probes in
 * `channel-entry-contract.ts`) can build their own start/stop logic and
 * still emit a line in the canonical format.
 */
export function formatPluginLoadProfileLine(params: {
  phase: string;
  pluginId?: string;
  source: string;
  elapsedMs: number;
  extras?: PluginLoadProfileExtras;
}): string {
  const extras = (params.extras ?? [])
    .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(1) : v}`)
    .join(" ");
  const extrasFragment = extras ? ` ${extras}` : "";
  return (
    `[plugin-load-profile] phase=${params.phase} plugin=${params.pluginId ?? "(core)"}` +
    ` elapsedMs=${params.elapsedMs.toFixed(1)}${extrasFragment} source=${params.source}`
  );
}

/**
 * Time a single synchronous step and emit a `[plugin-load-profile]` line.
 * Use this when you only need to wrap one call:
 *
 * ```ts
 * const mod = withProfile(
 *   { pluginId: id, source },
 *   "phase-name",
 *   () => loadIt(),
 * );
 * ```
 *
 * For repeated calls that share the same `{ pluginId, source }` scope,
 * prefer `createProfiler(scope)` and call the returned profiler.
 *
 * When the env flag is unset, this runs `run()` directly with no timing
 * overhead. Errors propagate naturally; the log line is still emitted via
 * `try { … } finally { … }`.
 */
export function withProfile<T>(
  scope: PluginLoadProfileScope,
  phase: string,
  run: () => T,
  extras?: PluginLoadProfileExtras,
): T {
  if (!shouldProfilePluginLoader()) {
    return run();
  }
  const startMs = performance.now();
  try {
    return run();
  } finally {
    const elapsedMs = performance.now() - startMs;
    console.error(
      formatPluginLoadProfileLine({
        phase,
        pluginId: scope.pluginId,
        source: scope.source,
        elapsedMs,
        extras,
      }),
    );
  }
}

/**
 * Build a scope-bound profiler. Useful when several consecutive steps share
 * the same `{ pluginId, source }`:
 *
 * ```ts
 * const profile = createProfiler({ pluginId: id, source: importMetaUrl });
 * profile("phase-a", () => stepA());
 * const v = profile("phase-b", () => stepB());
 * ```
 *
 * Each call has the same semantics as `withProfile(scope, phase, run)`.
 */
export function createProfiler(scope: PluginLoadProfileScope): PluginLoadProfiler {
  return (phase, run, extras) => withProfile(scope, phase, run, extras);
}
