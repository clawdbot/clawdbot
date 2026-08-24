const PRIVATE_WORKSPACE_VERSION = "0.0.0-private";

function dependenciesRecord(value, label) {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} dependencies must be an object when present`);
  }
  return value;
}

export function validateBundledPackageDependencyAlignment({
  bundledDependencies,
  bundledPackageLabel,
  rootDependencies,
  rootPackageLabel = "root package.json",
}) {
  const bundled = dependenciesRecord(bundledDependencies, bundledPackageLabel);
  const root = dependenciesRecord(rootDependencies, rootPackageLabel);
  const aligned = [];
  for (const [name, version] of Object.entries(bundled)) {
    if (typeof version !== "string") {
      throw new Error(`${bundledPackageLabel} dependency ${name} must declare a string version`);
    }
    if (version === PRIVATE_WORKSPACE_VERSION) {
      continue;
    }
    const rootVersion = root[name];
    if (rootVersion !== undefined && typeof rootVersion !== "string") {
      throw new Error(`${rootPackageLabel} dependency ${name} must declare a string version`);
    }
    if (rootVersion !== version && rootVersion !== `workspace:${version}`) {
      throw new Error(
        `${rootPackageLabel} must declare ${name}@${version} to bundle @openclaw/ai without duplicate dependencies`,
      );
    }
    aligned.push([name, version]);
  }
  return aligned;
}
