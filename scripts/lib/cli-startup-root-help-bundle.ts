// Resolves the generated root-help bundle identity for CLI startup metadata caching.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const OUTPUT_ROOT_HELP_EXPORT_RE =
  /\bexport\s+(?:(?:async\s+)?function|class|const|let|var)\s+outputRootHelp\b|\bexport\s*\{[^}]*\boutputRootHelp\s*(?=[,}])/u;

export function resolveCliStartupRootHelpBundleIdentity(
  distDir: string,
): { bundleName: string; signature: string } | null {
  for (const bundleName of readdirSync(distDir).toSorted()) {
    if (!bundleName.startsWith("root-help-") || !/\.m?js$/u.test(bundleName)) {
      continue;
    }
    const bundleContents = readFileSync(path.join(distDir, bundleName), "utf8");
    // The build emits multiple root-help chunks; only the renderer owns this cache identity.
    // Selecting a helper chunk forces metadata generation onto its expensive source fallback.
    if (!OUTPUT_ROOT_HELP_EXPORT_RE.test(bundleContents)) {
      continue;
    }
    const buildInfo = readBuildIdentity(distDir);
    return {
      bundleName,
      signature: createHash("sha1")
        .update(bundleContents)
        .update(JSON.stringify(buildInfo))
        .digest("hex"),
    };
  }
  return null;
}

function readBuildIdentity(distDir: string): { version: string | null; commit: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(distDir, "build-info.json"), "utf8")) as {
      commit?: unknown;
      version?: unknown;
    };
    return {
      version: typeof parsed.version === "string" ? parsed.version : null,
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
    };
  } catch {
    return { version: null, commit: null };
  }
}
