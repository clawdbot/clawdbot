import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCuaDriverArtifacts,
  readPackageIdentity,
  type CuaDriverArtifactVerification,
} from "./driver-artifact-verification.js";

const PLUGIN_PACKAGE = "@openclaw/cua-computer";

function resolvePluginManifestPath(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    for (const candidate of [
      path.join(current, "package.json"),
      path.join(current, "extensions", "cua-computer", "package.json"),
    ]) {
      try {
        if (readPackageIdentity(candidate).name === PLUGIN_PACKAGE) {
          return candidate;
        }
      } catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`unable to locate ${PLUGIN_PACKAGE} package.json`);
    }
    current = parent;
  }
}

const PLUGIN_MANIFEST_PATH = resolvePluginManifestPath();
const requireFromPlugin = createRequire(PLUGIN_MANIFEST_PATH);

function resolvePackageJson(packageName: string): string | undefined {
  try {
    return requireFromPlugin.resolve(`${packageName}/package.json`);
  } catch {}
  let entry: string;
  try {
    entry = fileURLToPath(import.meta.resolve(packageName));
  } catch {
    try {
      entry = requireFromPlugin.resolve(packageName);
    } catch {
      return undefined;
    }
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
    pluginManifestPath: PLUGIN_MANIFEST_PATH,
    resolvePackageJson,
  });
  return installedVerification;
}
