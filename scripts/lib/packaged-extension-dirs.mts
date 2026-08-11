export function collectExcludedPackagedExtensionDirs(rootPackageJson: { files?: unknown[] }) {
  const excluded = new Set<string>();
  const files = Array.isArray(rootPackageJson?.files) ? rootPackageJson.files : [];
  for (const entry of files) {
    if (typeof entry !== "string") {
      continue;
    }
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (match?.[1]) {
      excluded.add(match[1]);
    }
  }
  return excluded;
}
