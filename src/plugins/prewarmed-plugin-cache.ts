import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPrereleaseResolutionAllowed, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isRecord } from "../utils.js";

const COMMIT_RE = /^[a-f0-9]{40}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

export type PrewarmedPluginCacheResolution =
  | { status: "miss" }
  | { status: "invalid"; error: string }
  | {
      status: "hit";
      archivePath: string;
      archiveSHA256: string;
      canonicalSpec: string;
      packageVersion: string;
    };

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer);
      if (read === 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function resolveInstalledPrefix(packageRoot: string): string | undefined {
  const nodeModulesDir = path.dirname(packageRoot);
  const libDir = path.dirname(nodeModulesDir);
  const nodeDir = path.dirname(libDir);
  const toolsDir = path.dirname(nodeDir);
  if (path.basename(nodeModulesDir) !== "node_modules" || path.basename(libDir) !== "lib") {
    return undefined;
  }
  if (path.basename(toolsDir) !== "tools" || !path.basename(nodeDir).startsWith("node-v")) {
    return undefined;
  }
  return path.dirname(toolsDir);
}

export function resolvePrewarmedPluginCache(params: {
  pluginId: string;
  catalogNpmSpec: string;
  effectiveNpmSpec: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  stateDir?: string;
  buildInfo?: { version: string; commit: string };
}): PrewarmedPluginCacheResolution {
  const packageRoot =
    params.packageRoot ??
    resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }) ??
    undefined;
  if (!packageRoot) {
    return { status: "miss" };
  }
  const prefix = resolveInstalledPrefix(packageRoot);
  if (!prefix) {
    return { status: "miss" };
  }
  const stateDir = params.stateDir ?? resolveStateDir(params.env);
  if (path.resolve(prefix) !== path.resolve(stateDir)) {
    return { status: "miss" };
  }
  let buildInfo = params.buildInfo;
  try {
    buildInfo ??= JSON.parse(
      fs.readFileSync(path.join(packageRoot, "dist", "build-info.json"), "utf8"),
    );
  } catch {
    return { status: "miss" };
  }
  if (!buildInfo || !COMMIT_RE.test(buildInfo.commit) || !buildInfo.version) {
    return { status: "miss" };
  }
  const cacheDir = path.join(stateDir, "cache", "prewarmed-plugins", buildInfo.commit);
  const manifestPath = path.join(cacheDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { status: "miss" };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(manifest) || manifest.schemaVersion !== 1) {
      throw new Error("manifest schema is invalid");
    }
    if (manifest.appVersion !== buildInfo.version || manifest.gitCommit !== buildInfo.commit) {
      throw new Error("manifest build identity does not match the running OpenClaw runtime");
    }
    if (!Array.isArray(manifest.plugins)) {
      throw new Error("manifest plugin list is invalid");
    }
    const matches = manifest.plugins.filter(
      (value): value is Record<string, unknown> =>
        isRecord(value) && value.pluginId === params.pluginId,
    );
    if (matches.length === 0) {
      return { status: "miss" };
    }
    if (matches.length !== 1) {
      throw new Error("manifest contains duplicate plugin ids");
    }
    const entry = matches[0]!;
    const packageName = typeof entry.packageName === "string" ? entry.packageName : "";
    const packageVersion = typeof entry.packageVersion === "string" ? entry.packageVersion : "";
    const canonicalSpec = typeof entry.npmSpec === "string" ? entry.npmSpec : "";
    const archiveFile = typeof entry.archiveFile === "string" ? entry.archiveFile : "";
    const archiveSHA256 = typeof entry.archiveSHA256 === "string" ? entry.archiveSHA256 : "";
    const catalog = parseRegistryNpmSpec(params.catalogNpmSpec);
    const effective = parseRegistryNpmSpec(params.effectiveNpmSpec);
    if (!catalog || !effective || catalog.name !== packageName || effective.name !== packageName) {
      throw new Error("cached package does not match the official catalog package");
    }
    if (
      packageVersion !== buildInfo.version ||
      canonicalSpec !== `${packageName}@${packageVersion}` ||
      path.basename(archiveFile) !== archiveFile ||
      !archiveFile.endsWith(".tgz") ||
      !SHA256_RE.test(archiveSHA256)
    ) {
      throw new Error("cached package identity metadata is invalid");
    }
    if (
      (effective.selectorKind === "exact-version" && effective.selector !== packageVersion) ||
      (effective.selectorKind === "tag" && effective.selector?.toLowerCase() !== "latest")
    ) {
      return { status: "miss" };
    }
    if (!isPrereleaseResolutionAllowed({ spec: effective, resolvedVersion: packageVersion })) {
      return { status: "miss" };
    }
    const archivePath = path.join(cacheDir, archiveFile);
    const stat = fs.lstatSync(archivePath);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256File(archivePath) !== archiveSHA256) {
      throw new Error("cached package archive is missing or has changed");
    }
    return { status: "hit", archivePath, archiveSHA256, canonicalSpec, packageVersion };
  } catch (error) {
    return {
      status: "invalid",
      error: `Prewarmed plugin cache is invalid for ${params.pluginId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
