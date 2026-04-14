import fs from "node:fs";
import path from "node:path";

const JS_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectPackageJsonPaths(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name, "package.json"))
    .filter((packageJsonPath) => fs.existsSync(packageJsonPath))
    .toSorted((left, right) => left.localeCompare(right));
}

function usesStagedRuntimeDependencies(packageJson) {
  return packageJson?.openclaw?.bundle?.stageRuntimeDependencies === true;
}

function dependencySentinelPath(packageRoot, dependencyName) {
  return path.join(packageRoot, "node_modules", ...dependencyName.split("/"), "package.json");
}

function pluginIdFromPackageJsonPath(packageJsonPath) {
  return path.basename(path.dirname(packageJsonPath));
}

export function collectBundledPluginRuntimeDependencySpecs(bundledPluginsDir) {
  const specs = new Map();

  for (const packageJsonPath of collectPackageJsonPaths(bundledPluginsDir)) {
    const packageJson = readJson(packageJsonPath);
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

export function collectBuiltBundledPluginStagedRuntimeDependencyErrors(params) {
  const errors = [];

  for (const packageJsonPath of collectPackageJsonPaths(params.bundledPluginsDir)) {
    const packageJson = readJson(packageJsonPath);
    if (!usesStagedRuntimeDependencies(packageJson)) {
      continue;
    }
    const pluginId = pluginIdFromPackageJsonPath(packageJsonPath);
    const pluginRoot = path.dirname(packageJsonPath);

    for (const [dependencyName, spec] of collectRuntimeDependencySpecs(packageJson)) {
      if (!fs.existsSync(dependencySentinelPath(pluginRoot, dependencyName))) {
        const specText = String(spec);
        errors.push(
          `built bundled plugin '${pluginId}' is missing staged runtime dependency '${dependencyName}: ${specText}' under dist/extensions/${pluginId}/node_modules.`,
        );
      }
    }
  }

  return errors.toSorted((left, right) => left.localeCompare(right));
}

function walkJavaScriptFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) {
    return files;
  }
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (fullPath.split(path.sep).includes("extensions")) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && JS_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function extractModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  return specifiers;
}

export function collectRootDistBundledRuntimeMirrors(params) {
  const distDir = params.distDir;
  const bundledSpecs = params.bundledRuntimeDependencySpecs;
  const mirrors = new Map();

  for (const filePath of walkJavaScriptFiles(distDir)) {
    const source = fs.readFileSync(filePath, "utf8");
    const relativePath = path.relative(distDir, filePath).replaceAll(path.sep, "/");
    for (const specifier of extractModuleSpecifiers(source)) {
      const dependencyName = packageNameFromSpecifier(specifier);
      if (!dependencyName || !bundledSpecs.has(dependencyName)) {
        continue;
      }
      const bundledSpec = bundledSpecs.get(dependencyName);
      const existing = mirrors.get(dependencyName);
      if (existing) {
        existing.importers.add(relativePath);
        continue;
      }
      mirrors.set(dependencyName, {
        importers: new Set([relativePath]),
        pluginIds: bundledSpec.pluginIds,
        spec: bundledSpec.spec,
      });
    }
  }

  return mirrors;
}

export function collectBundledPluginRootRuntimeMirrorErrors(params) {
  const rootRuntimeDeps = collectRuntimeDependencySpecs(params.rootPackageJson);
  const errors = [];

  for (const [dependencyName, record] of params.bundledRuntimeDependencySpecs) {
    for (const conflict of record.conflicts) {
      errors.push(
        `bundled runtime dependency '${dependencyName}' has conflicting plugin specs: ${record.pluginIds.join(", ")} use '${record.spec}', ${conflict.pluginId} uses '${conflict.spec}'.`,
      );
    }
  }

  for (const [dependencyName, mirror] of params.requiredRootMirrors) {
    const rootSpec = rootRuntimeDeps.get(dependencyName);
    const importers = [...mirror.importers].toSorted((left, right) => left.localeCompare(right));
    const importerLabel = importers.join(", ");
    const pluginLabel = mirror.pluginIds
      .toSorted((left, right) => left.localeCompare(right))
      .join(", ");
    if (typeof rootSpec !== "string" || rootSpec.length === 0) {
      errors.push(
        `root dist imports bundled plugin runtime dependency '${dependencyName}' from ${importerLabel}; mirror '${dependencyName}: ${mirror.spec}' in root package.json (declared by ${pluginLabel}).`,
      );
      continue;
    }
    if (rootSpec !== mirror.spec) {
      errors.push(
        `root dist imports bundled plugin runtime dependency '${dependencyName}' from ${importerLabel}; root package.json has '${rootSpec}' but plugin manifest declares '${mirror.spec}' (${pluginLabel}).`,
      );
    }
  }

  return errors;
}
