type PackageChangelogOptions = { allowUnreleased?: boolean };

export function resolvePackageChangelogVersions(
  packageVersion: string,
  options?: PackageChangelogOptions,
): string[];
export function extractCurrentPackageChangelog(
  content: string,
  packageVersion: string,
  options?: PackageChangelogOptions,
): string;
export function restorePackageChangelog(cwd?: string): Promise<boolean>;
export function preparePackageChangelog(
  cwd?: string,
  options?: PackageChangelogOptions,
): Promise<boolean>;
