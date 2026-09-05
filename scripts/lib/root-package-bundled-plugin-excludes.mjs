import fs from "node:fs";
import path from "node:path";

/** Collect bundled plugin directories excluded from the root package artifact. */
export function collectRootPackageExcludedExtensionDirs(params = {}) {
  const packageJsonPath = path.join(params.cwd ?? process.cwd(), "package.json");
  const excluded = new Set();
  if (!fs.existsSync(packageJsonPath)) {
    return excluded;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const entry of packageJson.files ?? []) {
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
