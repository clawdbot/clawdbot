type PluginSurfaceManifest = {
  id?: string;
  channels?: string[];
  providers?: string[];
  commandAliases?: Array<{ name?: string; kind?: string }>;
  contracts?: Record<string, unknown>;
  dashboard?: Partial<Record<"actionVerbs" | "dataBindings", Array<{ id?: string }>>>;
  skills?: unknown[];
};

type PluginInventoryCoverageEntry = {
  dirName: string;
  id: string;
};

function duplicateValues(values: string[]) {
  return values
    .filter((value, index) => values.indexOf(value) !== index)
    .filter((value, index, duplicates) => duplicates.indexOf(value) === index)
    .toSorted((left, right) => left.localeCompare(right));
}

export function assertPluginInventoryCoverage(
  collectedEntries: PluginInventoryCoverageEntry[],
  manifestEntries: PluginInventoryCoverageEntry[],
) {
  const problems: string[] = [];
  for (const key of ["dirName", "id"] as const) {
    const collected = collectedEntries.map((entry) => entry[key]);
    const manifests = manifestEntries.map((entry) => entry[key]);
    const missing = manifests
      .filter((value) => !collected.includes(value))
      .toSorted((left, right) => left.localeCompare(right));
    const extra = collected
      .filter((value) => !manifests.includes(value))
      .toSorted((left, right) => left.localeCompare(right));
    const duplicateIds = key === "id" ? duplicateValues(manifests) : [];
    if (missing.length > 0) {
      problems.push(`missing ${key}s: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      problems.push(`extra ${key}s: ${extra.join(", ")}`);
    }
    if (duplicateIds.length > 0) {
      problems.push(`duplicate manifest ids: ${duplicateIds.join(", ")}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`plugin inventory coverage mismatch; ${problems.join("; ")}`);
  }
}

function formatIdentifiers(values: string[]) {
  return values.map((value) => `\`${value}\``).join(", ");
}

function encodeDashboardPluginIdSegment(pluginId: string) {
  return pluginId.replaceAll("%", "%25").replaceAll(".", "%2E");
}

function resolveDashboardCapabilityIds(
  manifest: PluginSurfaceManifest,
  field: "dataBindings" | "actionVerbs",
) {
  if (typeof manifest.id !== "string" || !Array.isArray(manifest.dashboard?.[field])) {
    return [];
  }
  const pluginIdSegment = encodeDashboardPluginIdSegment(manifest.id);
  return manifest.dashboard[field]
    .map((entry) =>
      typeof entry?.id === "string" && entry.id.length > 0
        ? `${pluginIdSegment}.${entry.id}`
        : null,
    )
    .filter((value) => value !== null);
}

export function resolvePluginSurface(manifest: PluginSurfaceManifest) {
  const parts = [];
  if (Array.isArray(manifest.channels) && manifest.channels.length > 0) {
    parts.push(`channels: ${formatIdentifiers(manifest.channels)}`);
  }
  if (Array.isArray(manifest.providers) && manifest.providers.length > 0) {
    parts.push(`providers: ${formatIdentifiers(manifest.providers)}`);
  }
  const commands = [
    ...new Set(
      (manifest.commandAliases ?? [])
        .filter((alias) => alias.kind === "runtime-slash")
        .map((alias) => alias.name?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
  if (commands.length > 0) {
    parts.push(`commands: ${formatIdentifiers(commands.map((name) => `/${name}`))}`);
  }
  const contracts = Object.keys(manifest.contracts ?? {}).toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (contracts.length > 0) {
    parts.push(`contracts: ${formatIdentifiers(contracts)}`);
  }
  const dashboardDataBindings = resolveDashboardCapabilityIds(manifest, "dataBindings");
  if (dashboardDataBindings.length > 0) {
    parts.push(`dashboard data bindings: ${formatIdentifiers(dashboardDataBindings)}`);
  }
  const dashboardActionVerbs = resolveDashboardCapabilityIds(manifest, "actionVerbs");
  if (dashboardActionVerbs.length > 0) {
    parts.push(`dashboard action verbs: ${formatIdentifiers(dashboardActionVerbs)}`);
  }
  if (Array.isArray(manifest.skills) && manifest.skills.length > 0) {
    parts.push("skills");
  }
  if (parts.length === 0) {
    return "plugin";
  }
  return parts.join("; ");
}
