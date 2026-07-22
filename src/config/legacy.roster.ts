/** Every missing or empty roster is the shipped implicit-main shape. */
export function migratePersistedImplicitMainRoster(raw: unknown): {
  config: unknown;
  changed: boolean;
  diagnostics: string[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const root = raw as Record<string, unknown>;
  if (
    Object.hasOwn(root, "agents") &&
    (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents))
  ) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const agents =
    root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
      ? (root.agents as Record<string, unknown>)
      : {};
  if (!Object.hasOwn(agents, "list") || (Array.isArray(agents.list) && agents.list.length === 0)) {
    return {
      config: { ...root, agents: { ...agents, list: [{ id: "main", default: true }] } },
      changed: true,
      diagnostics: [],
    };
  }
  const list = agents.list;
  if (!Array.isArray(list)) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const validIndexes = list.flatMap((entry, index) =>
    entry && typeof entry === "object" && !Array.isArray(entry) ? [index] : [],
  );
  if (validIndexes.length === 0) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const hasInvalidDefaultMarker = validIndexes.some((index) => {
    const entry = list[index] as Record<string, unknown>;
    return Object.hasOwn(entry, "default") && typeof entry.default !== "boolean";
  });
  if (hasInvalidDefaultMarker) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const defaultIndexes = validIndexes.filter(
    (index) => (list[index] as Record<string, unknown>).default === true,
  );
  if (defaultIndexes.length === 1) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const effectiveIndex = defaultIndexes[0] ?? validIndexes[0]!;
  const repaired = list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const next = Object.assign({}, entry as Record<string, unknown>);
    if (index === effectiveIndex) {
      next.default = true;
    } else {
      delete next.default;
    }
    return next;
  });
  return {
    config: { ...root, agents: { ...agents, list: repaired } },
    changed: true,
    diagnostics: [
      defaultIndexes.length === 0
        ? "Migrated agents.list by marking the first entry as default."
        : `Migrated agents.list by keeping agents.list.${effectiveIndex} as default and clearing ${defaultIndexes.length - 1} duplicate marker(s).`,
    ],
  };
}
