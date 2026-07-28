// Resolves the generated root-help bundle identity for CLI startup metadata caching.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function resolveCliStartupRootHelpBundleIdentity(
  distDir: string,
): { bundleName: string; signature: string } | null {
  const bundleName = readdirSync(distDir).find(
    (entry) =>
      entry.startsWith("root-help-") &&
      !entry.startsWith("root-help-metadata-") &&
      entry.endsWith(".js"),
  );
  if (!bundleName) {
    return null;
  }
  const bundleContents = readFileSync(path.join(distDir, bundleName), "utf8");
  const buildInfo = readBuildIdentity(distDir);
  return {
    bundleName,
    signature: createHash("sha1")
      .update(bundleContents)
      .update(JSON.stringify(buildInfo))
      .digest("hex"),
  };
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
