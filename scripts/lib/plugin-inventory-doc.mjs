function formatIdentifiers(values) {
  return values.map((value) => `\`${value}\``).join(", ");
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
  if (Array.isArray(manifest.skills) && manifest.skills.length > 0) {
    parts.push("skills");
  }
  if (parts.length === 0) {
    return "plugin";
  }
  return parts.join("; ");
}
