import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pluginManifest from "../package.json" with { type: "json" };
import {
  inspectCuaDriverArtifacts,
  readPackageIdentity,
  type CuaDriverArtifactVerification,
} from "./driver-artifact-verification.js";

const requireFromPlugin = createRequire(import.meta.url);

function resolvePackageEntry(packageName: string): string | undefined {
  try {
    return requireFromPlugin.resolve(packageName);
  } catch {}
  // The CUA Driver SDK is ESM-only: its exports map carries only the "import"
  // condition, so require-condition resolution throws PATH_NOT_EXPORTED even
  // when the package is installed. Resolve with import conditions before
  // concluding the package is missing.
  try {
    return fileURLToPath(import.meta.resolve(packageName));
  } catch {
    return undefined;
  }
}

function resolvePackageJson(packageName: string): string | undefined {
  try {
    return requireFromPlugin.resolve(`${packageName}/package.json`);
  } catch {}
  const entry = resolvePackageEntry(packageName);
  if (!entry) {
    return undefined;
  }
  let current = path.dirname(entry);
  while (true) {
    const candidate = path.join(current, "package.json");
    try {
      if (readPackageIdentity(candidate).name === packageName) {
        return candidate;
      }
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function detectLinuxLibc(): "gnu" | "musl" {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined;
  return typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
}

let installedVerification: CuaDriverArtifactVerification | undefined;

export function verifyInstalledCuaDriverArtifacts(): CuaDriverArtifactVerification {
  installedVerification ??= inspectCuaDriverArtifacts({
    platform: process.platform,
    arch: process.arch,
    ...(process.platform === "linux" ? { linuxLibc: detectLinuxLibc() } : {}),
    pluginManifest,
    resolvePackageJson,
  });
  return installedVerification;
}
