export function validateBundledPackageDependencyAlignment(params: {
  bundledDependencies?: unknown;
  bundledPackageLabel: string;
  rootDependencies?: unknown;
  rootPackageLabel?: string;
}): Array<[string, string]>;
