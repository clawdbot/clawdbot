function formatIdentifiers(values) {
  return values.map((value) => `\`${value}\``).join(", ");
}

function encodeDashboardPluginIdSegment(pluginId) {
  return pluginId.replaceAll("%", "%25").replaceAll(".", "%2E");
}

function resolveDashboardCapabilityIds(manifest, field) {
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

export function resolvePluginSurface(manifest) {
  const parts = [];
  if (Array.isArray(manifest.channels) && manifest.channels.length > 0) {
    parts.push(`channels: ${formatIdentifiers(manifest.channels)}`);
  }
  if (Array.isArray(manifest.providers) && manifest.providers.length > 0) {
    parts.push(`providers: ${formatIdentifiers(manifest.providers)}`);
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
