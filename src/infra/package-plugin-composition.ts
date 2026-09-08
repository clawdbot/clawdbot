import { satisfies, valid } from "semver";
import { validateBundledPackageDependencyAlignment } from "../../scripts/package-source-dependencies.mjs";

export type DistributionPackageManifest = {
  name: string;
  version: string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/** Shared dependency ownership for release packages and private node distributions. */
export function composePackagePlugins<T extends DistributionPackageManifest>(
  packageJson: T,
  plugins: readonly { id: string; packageJson: DistributionPackageManifest }[],
): T {
  const composed = structuredClone(packageJson);
  for (const { id, packageJson: plugin } of plugins) {
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = plugin[section] ?? {};
      for (const [name, spec] of Object.entries(dependencies)) {
        if (valid(spec) !== spec) {
          throw new Error(
            `Selected plugin ${id} requires an exact dependency pin: ${name}@${spec}`,
          );
        }
      }
      for (const existing of [composed.dependencies, composed.optionalDependencies]) {
        validateBundledPackageDependencyAlignment({
          bundledDependencies: dependencies,
          bundledPackageLabel: `selected plugin ${id}`,
          rootDependencies: { ...dependencies, ...existing },
        });
      }
      composed[section] = { ...composed[section], ...dependencies };
    }
  }
  // A required dependency cannot stay optional when another selected owner needs it.
  for (const name of Object.keys(composed.dependencies ?? {})) {
    delete composed.optionalDependencies?.[name];
  }
  for (const { id, packageJson: plugin } of plugins) {
    for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
      const version =
        name === composed.name
          ? composed.version
          : (composed.dependencies?.[name] ?? composed.optionalDependencies?.[name]);
      if (
        (!version && !plugin.peerDependenciesMeta?.[name]?.optional) ||
        (version && !satisfies(version, range))
      ) {
        throw new Error(`Selected plugin ${id} requires peer ${name}@${range} in the distribution`);
      }
    }
  }
  const exclusions = new Set(plugins.map(({ id }) => `!dist/extensions/${id}/**`));
  if (composed.files) {
    composed.files = composed.files.filter((entry) => !exclusions.has(entry));
  }
  return composed;
}
