// Builds compact plugin health summaries for chat status surfaces.
import type { PluginDiagnosticCode } from "../plugins/manifest-types.js";

type StatusPluginDependencyStatus = {
  hasDependencies?: boolean;
  requiredInstalled?: boolean;
  missing?: string[];
};

export type PluginHealthRecord = {
  id: string;
  status?: "loaded" | "disabled" | "error";
  enabled?: boolean;
  error?: string;
  dependencyStatus?: StatusPluginDependencyStatus;
  failurePhase?: string;
};

export type PluginDiagnosticRecord = {
  level: "warn" | "error";
  message: string;
  pluginId?: string;
  code?: PluginDiagnosticCode;
};

type ContextEngineQuarantineRecord = {
  engineId: string;
  owner?: string;
  operation: string;
  reason: string;
  failedAt: Date | number;
};

export type RuntimeToolQuarantineRecord = {
  toolName: string;
  owner?: string;
  reason: string;
  failedAt: Date | number;
};

export type PluginCompatibilityHealthNotice = {
  pluginId: string;
  severity: "warn" | "info";
  message: string;
  code?: string;
};

export type ChannelPluginFailureRecord = {
  channelId: string;
  pluginId?: string;
  message: string;
  source?: string;
};

export type StatusPluginHealthSnapshot = {
  plugins: PluginHealthRecord[];
  diagnostics: PluginDiagnosticRecord[];
  contextEngineQuarantines: ContextEngineQuarantineRecord[];
  runtimeToolQuarantines?: RuntimeToolQuarantineRecord[];
  compatibilityNotices?: PluginCompatibilityHealthNotice[];
  channelPluginFailures?: ChannelPluginFailureRecord[];
  // Plugin ids confirmed loaded in the active runtime registry (status "loaded").
  // Lets detailed status separate runtime-loaded plugins from installed/discovered
  // inventory (the disk scan marks config-enabled plugins "loaded" before runtime
  // load). Absent on hand-built/compact snapshots, where detailed rendering falls
  // back to the merged status filter.
  runtimeLoadedPluginIds?: string[];
  // Eager should-run plugin ids from the gateway startup plan (deferred channel
  // plugins already excluded). Paired with runtimeLoadedPluginIds, it lets detailed
  // status flag desired-vs-observed drift: a plugin the gateway planned to start that
  // is not in the runtime-loaded set. Absent on compact/hand-built snapshots, where
  // no drift line is rendered (back-compat).
  shouldRunPluginIds?: string[];
  // Configured memory embedding providers (memorySearch provider/fallback) that no
  // loaded plugin registers, so semantic memory recall silently falls back to
  // keyword/FTS-only. Detailed-status only; absent on compact/hand-built snapshots and
  // whenever the live runtime registry is unavailable, so no line renders (back-compat).
  // `source` mirrors MemoryEmbeddingStartupProviderSource ("provider" | "fallback").
  unregisteredMemoryEmbeddingProviders?: Array<{
    configuredId: string;
    source: "provider" | "fallback";
  }>;
};

/** Keeps the first record per key; later duplicates are dropped. */
function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }
  return [...seen.values()];
}

export function dedupePluginDiagnostics(
  diagnostics: readonly PluginDiagnosticRecord[],
): PluginDiagnosticRecord[] {
  return dedupeBy(diagnostics, (entry) =>
    JSON.stringify([entry.level, entry.pluginId ?? "", entry.code ?? "", entry.message]),
  );
}

// The key ignores `source` so the same failure surfaced via loader diagnostics
// and via channel resolution dedupes; callers list the preferred record first.
export function dedupeChannelPluginFailures(
  failures: readonly ChannelPluginFailureRecord[],
): ChannelPluginFailureRecord[] {
  return dedupeBy(failures, (entry) =>
    JSON.stringify([entry.channelId, entry.pluginId ?? "", entry.message]),
  );
}

function dedupeCompatibilityNotices(
  notices: readonly PluginCompatibilityHealthNotice[],
): PluginCompatibilityHealthNotice[] {
  return dedupeBy(notices, (entry) =>
    JSON.stringify([entry.pluginId, entry.severity, entry.code ?? "", entry.message]),
  );
}

function mergePluginRecords(
  installed: readonly PluginHealthRecord[],
  runtime: readonly PluginHealthRecord[],
): PluginHealthRecord[] {
  const merged = new Map<string, PluginHealthRecord>();
  for (const plugin of installed) {
    merged.set(plugin.id, plugin);
  }
  for (const plugin of runtime) {
    const existing = merged.get(plugin.id);
    // Field-wise merge: runtime facts win, but a runtime record missing a
    // field never erases what the installed scan knew.
    merged.set(plugin.id, {
      id: plugin.id,
      status: plugin.status ?? existing?.status,
      enabled: plugin.enabled ?? existing?.enabled,
      error: plugin.error ?? existing?.error,
      dependencyStatus: plugin.dependencyStatus ?? existing?.dependencyStatus,
      failurePhase: plugin.failurePhase ?? existing?.failurePhase,
    });
  }
  return [...merged.values()];
}

export function mergeStatusPluginHealthSnapshots(
  installed: StatusPluginHealthSnapshot,
  runtime: StatusPluginHealthSnapshot,
): StatusPluginHealthSnapshot {
  return {
    plugins: mergePluginRecords(installed.plugins, runtime.plugins),
    diagnostics: dedupePluginDiagnostics([...installed.diagnostics, ...runtime.diagnostics]),
    contextEngineQuarantines: [
      ...installed.contextEngineQuarantines,
      ...runtime.contextEngineQuarantines,
    ],
    runtimeToolQuarantines: [
      ...(installed.runtimeToolQuarantines ?? []),
      ...(runtime.runtimeToolQuarantines ?? []),
    ],
    channelPluginFailures: dedupeChannelPluginFailures([
      ...(installed.channelPluginFailures ?? []),
      ...(runtime.channelPluginFailures ?? []),
    ]),
    compatibilityNotices: dedupeCompatibilityNotices([
      ...(installed.compatibilityNotices ?? []),
      ...(runtime.compatibilityNotices ?? []),
    ]),
    // Runtime-loaded provenance is a runtime-side fact; the installed disk scan
    // cannot confirm it, so it never contributes here.
    runtimeLoadedPluginIds: runtime.runtimeLoadedPluginIds,
  };
}

function hasDependencyIssue(plugin: PluginHealthRecord): boolean {
  return (
    plugin.enabled !== false &&
    plugin.dependencyStatus?.hasDependencies === true &&
    plugin.dependencyStatus.requiredInstalled === false
  );
}

function shouldSuppressChannelPluginDiagnostic(
  diagnostic: PluginDiagnosticRecord,
  channelPluginFailures: readonly ChannelPluginFailureRecord[],
): boolean {
  if (!isChannelPluginFailureDiagnostic(diagnostic)) {
    return false;
  }
  // Only suppress when the failure is actually reported in the channel
  // section; otherwise the diagnostic must still count as a problem.
  return channelPluginFailures.some(
    (failure) =>
      failure.message === diagnostic.message &&
      (failure.pluginId == null ||
        diagnostic.pluginId == null ||
        failure.pluginId === diagnostic.pluginId),
  );
}

function getReportableDiagnostics(snapshot: StatusPluginHealthSnapshot): PluginDiagnosticRecord[] {
  const channelPluginFailures = snapshot.channelPluginFailures ?? [];
  return snapshot.diagnostics.filter(
    (entry) => !shouldSuppressChannelPluginDiagnostic(entry, channelPluginFailures),
  );
}

function countProblemDiagnostics(diagnostics: readonly PluginDiagnosticRecord[]): {
  errors: number;
  warnings: number;
} {
  return {
    errors: diagnostics.filter((entry) => entry.level === "error").length,
    warnings: diagnostics.filter((entry) => entry.level === "warn").length,
  };
}

export function isChannelPluginFailureDiagnostic(diagnostic: PluginDiagnosticRecord): boolean {
  return diagnostic.level === "error" && diagnostic.code === "channel-setup-failure";
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatCompactPluginHealthLine(
  snapshot: StatusPluginHealthSnapshot,
): string | undefined {
  const loadErrors = snapshot.plugins.filter((plugin) => plugin.status === "error").length;
  const dependencyIssues = snapshot.plugins.filter(hasDependencyIssue).length;
  const diagnosticErrors = countProblemDiagnostics(getReportableDiagnostics(snapshot)).errors;
  const quarantines = snapshot.contextEngineQuarantines.length;
  const runtimeToolQuarantines = snapshot.runtimeToolQuarantines?.length ?? 0;
  const channelPluginFailures = snapshot.channelPluginFailures?.length ?? 0;

  const parts = [
    loadErrors > 0 ? formatCount(loadErrors, "plugin error") : null,
    quarantines > 0 ? formatCount(quarantines, "context engine quarantine") : null,
    runtimeToolQuarantines > 0
      ? formatCount(runtimeToolQuarantines, "runtime tool quarantine")
      : null,
    channelPluginFailures > 0 ? formatCount(channelPluginFailures, "channel plugin failure") : null,
    dependencyIssues > 0 ? formatCount(dependencyIssues, "dependency issue") : null,
    diagnosticErrors > 0 ? formatCount(diagnosticErrors, "diagnostic error") : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length === 0 ? undefined : `⚠️ Plugins: ${parts.join(" · ")}`;
}

function formatPluginList(ids: readonly string[], limit: number): string {
  if (ids.length === 0) {
    return "none";
  }
  const visible = ids.slice(0, limit).join(", ");
  return ids.length > limit ? `${visible}, +${ids.length - limit} more` : visible;
}

function byLocale(left: string, right: string): number {
  return left.localeCompare(right);
}

export function formatDetailedPluginHealth(snapshot: StatusPluginHealthSnapshot): string {
  const statusLoaded = snapshot.plugins.filter((plugin) => plugin.status === "loaded");
  // "Loaded" must mean runtime-confirmed loaded. When the snapshot carries runtime
  // provenance, render that authoritative id set directly (it spans all live
  // registry surfaces, so a plugin live only via a pinned surface still lists even
  // when it is absent from the merged records); installed-but-not-active is then
  // the status-loaded records the runtime did not load. Fall back to the raw
  // status when provenance is absent (hand-built/compact snapshots).
  const runtimeLoadedIds = snapshot.runtimeLoadedPluginIds;
  const runtimeLoaded = runtimeLoadedIds ? new Set(runtimeLoadedIds) : undefined;
  const loaded = (runtimeLoadedIds ?? statusLoaded.map((plugin) => plugin.id)).toSorted(byLocale);
  // Desired-vs-observed drift: ids the gateway's eager startup plan says should run
  // but that are absent from the runtime-loaded set and not already explained by an
  // error/disabled record (those surface in their own sections). Computed only when
  // both the should-run set and runtime provenance are present, so compact/hand-built
  // snapshots render exactly as before.
  const explainedPluginIds = new Set(
    snapshot.plugins
      .filter((plugin) => plugin.status === "error" || plugin.status === "disabled")
      .map((plugin) => plugin.id),
  );
  const shouldRunNotLoaded =
    snapshot.shouldRunPluginIds && runtimeLoaded
      ? snapshot.shouldRunPluginIds
          .filter((id) => !runtimeLoaded.has(id) && !explainedPluginIds.has(id))
          .toSorted(byLocale)
      : [];
  const shouldRunNotLoadedSet = new Set(shouldRunNotLoaded);
  const installedNotActive = runtimeLoaded
    ? statusLoaded
        .filter((plugin) => !runtimeLoaded.has(plugin.id))
        .map((plugin) => plugin.id)
        // Drift ids are reported on their own line below; keep them out of the
        // neutral "Installed (not active)" inventory so each id appears once.
        .filter((id) => !shouldRunNotLoadedSet.has(id))
        .toSorted(byLocale)
    : [];
  const disabledPlugins = snapshot.plugins
    .filter((plugin) => plugin.status === "disabled")
    .toSorted((left, right) => byLocale(left.id, right.id));
  const errors = snapshot.plugins
    .filter((plugin) => plugin.status === "error")
    .toSorted((left, right) => byLocale(left.id, right.id));
  const dependencyIssues = snapshot.plugins
    .filter(hasDependencyIssue)
    .toSorted((left, right) => byLocale(left.id, right.id));
  const diagnostics = getReportableDiagnostics(snapshot);
  const diagnosticCounts = countProblemDiagnostics(diagnostics);
  const contextEngineQuarantines = snapshot.contextEngineQuarantines.toSorted((left, right) =>
    byLocale(left.engineId, right.engineId),
  );
  const runtimeToolQuarantines = (snapshot.runtimeToolQuarantines ?? []).toSorted((left, right) =>
    byLocale(left.toolName, right.toolName),
  );
  const compatibilityNotices = (snapshot.compatibilityNotices ?? []).toSorted((left, right) =>
    byLocale(left.pluginId, right.pluginId),
  );
  const channelPluginFailures = (snapshot.channelPluginFailures ?? []).toSorted((left, right) =>
    byLocale(left.channelId, right.channelId),
  );
  const unregisteredMemoryProviders = (
    snapshot.unregisteredMemoryEmbeddingProviders ?? []
  ).toSorted(
    (left, right) =>
      byLocale(left.configuredId, right.configuredId) || byLocale(left.source, right.source),
  );
  const lines = [
    formatCompactPluginHealthLine(snapshot) ?? "🔌 Plugins: OK",
    `Loaded: ${loaded.length}${loaded.length > 0 ? ` (${formatPluginList(loaded, 8)})` : ""}`,
    `Disabled: ${disabledPlugins.length}`,
  ];

  if (disabledPlugins.length > 0) {
    // Disable decisions record their reason on `error` (config off, allow/denylist,
    // overridden-by/memory-slot arbitration). Group ids per distinct reason so the
    // detailed view answers "why is this plugin off" without a /plugins round-trip,
    // and a restrictive allowlist folds into one bounded line instead of dozens.
    const disabledByReason = new Map<string, string[]>();
    for (const plugin of disabledPlugins) {
      const reason = plugin.error ?? "disabled";
      const ids = disabledByReason.get(reason);
      if (ids) {
        ids.push(plugin.id);
      } else {
        disabledByReason.set(reason, [plugin.id]);
      }
    }
    const reasonEntries = [...disabledByReason.entries()].toSorted((left, right) =>
      byLocale(left[0], right[0]),
    );
    lines.push(
      ...reasonEntries
        .slice(0, 8)
        .map(([reason, ids]) => `- ${reason}: ${ids.length} (${formatPluginList(ids, 8)})`),
    );
    if (reasonEntries.length > 8) {
      // Unlike the per-plugin buckets, the count above tallies plugins, not
      // reasons, so a reader cannot infer that reason lines were truncated.
      lines.push(`- +${reasonEntries.length - 8} more reasons`);
    }
  }

  if (installedNotActive.length > 0) {
    // Installed/discovered plugins not loaded in the runtime registry. Neutral
    // inventory, not an error: the gateway only starts the plugins its startup
    // plan requires, so configured-but-not-started is a normal steady state.
    lines.push(
      `Installed (not active): ${installedNotActive.length} (${formatPluginList(installedNotActive, 8)})`,
    );
  }

  if (shouldRunNotLoaded.length > 0) {
    // Planned for eager startup but missing from the live runtime-loaded set (e.g.,
    // config changed since the gateway started, or a planned plugin did not come up).
    // Observer-only signal, distinct from neutral inventory; not an error chip and
    // not counted in the compact line.
    lines.push(
      `Configured to run but not loaded: ${shouldRunNotLoaded.length} (${formatPluginList(shouldRunNotLoaded, 8)})`,
    );
  }

  if (unregisteredMemoryProviders.length > 0) {
    // A configured memory embedding provider that no loaded plugin registers: semantic
    // memory recall silently falls back to keyword/FTS-only. Observer-only signal, distinct
    // from plugin load/error state and not counted in the compact line.
    const display = unregisteredMemoryProviders.map(
      (entry) => `${entry.configuredId} (memorySearch.${entry.source})`,
    );
    lines.push(
      `Configured memory provider not registered: ${unregisteredMemoryProviders.length} (${formatPluginList(display, 8)})`,
    );
  }

  if (errors.length > 0) {
    lines.push(
      `Errors: ${errors.length}`,
      ...errors.slice(0, 8).map((plugin) => {
        const phase = plugin.failurePhase ? ` [${plugin.failurePhase}]` : "";
        return `- ${plugin.id}${phase}: ${plugin.error ?? "failed to load"}`;
      }),
    );
  }

  if (contextEngineQuarantines.length > 0) {
    lines.push(
      `Context engine quarantines: ${contextEngineQuarantines.length}`,
      ...contextEngineQuarantines.slice(0, 8).map((entry) => {
        const owner = entry.owner ? ` owner=${entry.owner}` : "";
        return `- ${entry.engineId}${owner} during ${entry.operation}: ${entry.reason}`;
      }),
    );
  }

  if (runtimeToolQuarantines.length > 0) {
    lines.push(
      `Runtime tool quarantines: ${runtimeToolQuarantines.length}`,
      ...runtimeToolQuarantines.slice(0, 8).map((entry) => {
        const owner = entry.owner ? ` owner=${entry.owner}` : "";
        return `- ${entry.toolName}${owner}: ${entry.reason}`;
      }),
    );
  }

  if (channelPluginFailures.length > 0) {
    lines.push(
      `Channel plugin failures: ${channelPluginFailures.length}`,
      ...channelPluginFailures.slice(0, 8).map((entry) => {
        const plugin = entry.pluginId ? ` plugin=${entry.pluginId}` : "";
        const source = entry.source ? ` [${entry.source}]` : "";
        return `- ${entry.channelId}${plugin}${source}: ${entry.message}`;
      }),
    );
  }

  if (dependencyIssues.length > 0) {
    lines.push(
      `Dependency issues: ${dependencyIssues.length}`,
      ...dependencyIssues.slice(0, 8).map((plugin) => {
        const missing = plugin.dependencyStatus?.missing ?? [];
        return `- ${plugin.id}: missing ${missing.join(", ") || "required dependencies"}`;
      }),
    );
  }

  if (diagnosticCounts.errors > 0 || diagnosticCounts.warnings > 0) {
    lines.push(
      `Diagnostics: ${diagnosticCounts.errors} errors · ${diagnosticCounts.warnings} warnings`,
    );
    for (const diagnostic of diagnostics.slice(0, 8)) {
      const target = diagnostic.pluginId ? `${diagnostic.pluginId}: ` : "";
      lines.push(`- ${diagnostic.level.toUpperCase()} ${target}${diagnostic.message}`);
    }
  }

  if (compatibilityNotices.length > 0) {
    lines.push(
      `Compatibility notices: ${compatibilityNotices.length}`,
      ...compatibilityNotices.slice(0, 8).map((notice) => {
        const code = notice.code ? ` [${notice.code}]` : "";
        return `- ${notice.severity.toUpperCase()} ${notice.pluginId}${code}: ${notice.message}`;
      }),
    );
  }

  lines.push("Full inventory: /plugins list");
  return lines.join("\n");
}
