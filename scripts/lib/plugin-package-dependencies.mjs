import fs from "node:fs";
import path from "node:path";

export function collectRuntimeDependencySpecs(packageJson = {}) {
  return new Map(
    [
      ...Object.entries(packageJson.dependencies ?? {}),
      ...Object.entries(packageJson.optionalDependencies ?? {}),
    ].filter((entry) => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

export function packageNameFromSpecifier(specifier) {
  if (
    typeof specifier !== "string" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const [first, second] = specifier.split("/");
  if (!first) {
    return null;
  }
  return first.startsWith("@") && second ? `${first}/${second}` : first;
}

export function collectBundledPluginPackageDependencySpecs(bundledPluginsDir) {
  const specs = new Map();

  if (!fs.existsSync(bundledPluginsDir)) {
    return specs;
  }

  const packageJsonPaths = fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(bundledPluginsDir, entry.name, "package.json"))
    .filter((packageJsonPath) => fs.existsSync(packageJsonPath))
    .toSorted((left, right) => left.localeCompare(right));

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const pluginId = path.basename(path.dirname(packageJsonPath));
    for (const [name, spec] of collectRuntimeDependencySpecs(packageJson)) {
      const existing = specs.get(name);
      if (existing) {
        if (existing.spec !== spec) {
          existing.conflicts.push({ pluginId, spec });
        } else if (!existing.pluginIds.includes(pluginId)) {
          existing.pluginIds.push(pluginId);
        }
        continue;
      }
      specs.set(name, { conflicts: [], pluginIds: [pluginId], spec });
    }
  }

  return specs;
}
