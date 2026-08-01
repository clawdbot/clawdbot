// Collects core dependency status for plugin diagnostics.
import fs from "node:fs";
import path from "node:path";

/** Dependency name-to-version map from a plugin package manifest. */
export type PluginDependencySpecMap = Record<string, string>;

/** Installation status for one plugin dependency. */
type PluginDependencyEntry = {
  name: string;
  spec: string;
  installed: boolean;
  optional: boolean;
  resolvedPath?: string;
};

/** Aggregate installation status for required and optional plugin dependencies. */
export type PluginDependencyStatus = {
  hasDependencies: boolean;
  installed: boolean;
  requiredInstalled: boolean;
  optionalInstalled: boolean;
  missing: string[];
  missingOptional: string[];
  dependencies: PluginDependencyEntry[];
  optionalDependencies: PluginDependencyEntry[];
};

type PluginDependencyHealthRegistry = {
  plugins: Array<{
    id: string;
    source: string;
    enabled: boolean;
    status: "loaded" | "disabled" | "error";
    error?: string;
    dependencyStatus?: PluginDependencyStatus;
  }>;
  diagnostics: Array<{
    level: "warn" | "error";
    message: string;
    pluginId?: string;
    source?: string;
  }>;
};

function normalizeDependencyMap(raw: unknown): PluginDependencySpecMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: PluginDependencySpecMap = {};
  for (const [name, spec] of Object.entries(raw)) {
    const normalizedName = name.trim();
    if (!normalizedName || typeof spec !== "string" || !spec.trim()) {
      continue;
    }
    normalized[normalizedName] = spec.trim();
  }
  return normalized;
}

/** Normalizes raw package dependency maps into sorted plugin dependency specs. */
export function normalizePluginDependencySpecs(params: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
}): {
  dependencies: PluginDependencySpecMap;
  optionalDependencies: PluginDependencySpecMap;
} {
  const dependencies = normalizeDependencyMap(params.dependencies);
  const optionalDependencies = normalizeDependencyMap(params.optionalDependencies);
  for (const name of Object.keys(optionalDependencies)) {
    delete dependencies[name];
  }
  return {
    dependencies,
    optionalDependencies,
  };
}

function dependencyPathSegments(name: string): string[] | null {
  const segments = name.split("/");
  if (segments.length === 1 && segments[0]) {
    return [segments[0]];
  }
  if (segments.length === 2 && segments[0]?.startsWith("@") && segments[1]) {
    return segments;
  }
  return null;
}

function findDependencyPackageDir(params: { fromDir: string; name: string }): string | undefined {
  const segments = dependencyPathSegments(params.name);
  if (!segments) {
    return undefined;
  }
  let current = path.resolve(params.fromDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function buildDependencyEntries(params: {
  rootDir: string | undefined;
  dependencies: PluginDependencySpecMap;
  optional: boolean;
}): PluginDependencyEntry[] {
  return Object.entries(params.dependencies)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => {
      const resolvedPath = params.rootDir
        ? findDependencyPackageDir({ fromDir: params.rootDir, name })
        : undefined;
      const entry: PluginDependencyEntry = {
        name,
        spec,
        installed: resolvedPath !== undefined,
        optional: params.optional,
      };
      if (resolvedPath) {
        entry.resolvedPath = resolvedPath;
      }
      return entry;
    });
}

/** Builds dependency installation status for a plugin package root. */
export function buildPluginDependencyStatus(params: {
  rootDir?: string;
  dependencies?: PluginDependencySpecMap;
  optionalDependencies?: PluginDependencySpecMap;
}): PluginDependencyStatus {
  const dependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencies: params.dependencies ?? {},
    optional: false,
  });
  const optionalDependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencies: params.optionalDependencies ?? {},
    optional: true,
  });
  const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
  const missingOptional = optionalDependencies
    .filter((entry) => !entry.installed)
    .map((entry) => entry.name);
  const requiredInstalled = missing.length === 0;
  const optionalInstalled = missingOptional.length === 0;
  return {
    hasDependencies: dependencies.length > 0 || optionalDependencies.length > 0,
    installed: requiredInstalled,
    requiredInstalled,
    optionalInstalled,
    missing,
    missingOptional,
    dependencies,
    optionalDependencies,
  };
}

/** Projects missing required dependencies consistently across cold plugin status surfaces. */
export function projectPluginDependencyHealth<T extends PluginDependencyHealthRegistry>(
  registry: T,
): T {
  const diagnostics = [...registry.diagnostics];
  const plugins = registry.plugins.map((plugin) => {
    const status = plugin.dependencyStatus;
    if (!plugin.enabled || status?.requiredInstalled !== false) {
      return plugin;
    }
    const message =
      `Plugin "${plugin.id}" cannot load because required dependencies are missing: ` +
      `${status.missing.join(", ")}. Install the plugin dependencies or reinstall/update the ` +
      "plugin, then restart the Gateway.";
    const existingDiagnosticIndex = diagnostics.findIndex(
      (entry) => entry.level === "error" && entry.pluginId === plugin.id,
    );
    if (existingDiagnosticIndex === -1) {
      diagnostics.push({ level: "error", pluginId: plugin.id, source: plugin.source, message });
    } else {
      const existingDiagnostic = diagnostics[existingDiagnosticIndex];
      if (existingDiagnostic && !existingDiagnostic.message.includes(message)) {
        diagnostics[existingDiagnosticIndex] = {
          ...existingDiagnostic,
          message: `${existingDiagnostic.message}\n${message}`,
        };
      }
    }
    if (plugin.status === "error") {
      const existingError = plugin.error;
      return {
        ...plugin,
        error:
          existingError && !existingError.includes(message)
            ? `${existingError}\n${message}`
            : (existingError ?? message),
      };
    }
    return { ...plugin, status: "error" as const, error: message };
  });
  return { ...registry, plugins, diagnostics };
}
