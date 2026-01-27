import fs from "node:fs";
import path from "node:path";

import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  getPackageManifestMetadata,
  type MoltbotPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import type { PluginDiagnostic, PluginOrigin } from "./types.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

export type PluginCandidate = {
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageMoltbot?: MoltbotPackageManifest;
};

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};

function isExtensionFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!EXTENSION_EXTS.has(ext)) return false;
  return !filePath.endsWith(".d.ts");
}

function readPackageManifest(dir: string): PackageManifest | null {
  const manifestPath = path.join(dir, "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
}

function resolvePackageExtensions(manifest: PackageManifest): string[] {
  const raw = getPackageManifestMetadata(manifest)?.extensions;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function deriveIdHint(params: {
  filePath: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) return base;

  // Prefer the unscoped name so config keys stay stable even when the npm
  // package is scoped (example: @moltbot/voice-call -> voice-call).
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;

  if (!params.hasMultipleExtensions) return unscoped;
  return `${unscoped}/${base}`;
}

function addCandidate(params: {
  candidates: PluginCandidate[];
  seen: Set<string>;
  idHint: string;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  packageDir?: string;
}) {
  const resolved = path.resolve(params.source);
  if (params.seen.has(resolved)) return;
  params.seen.add(resolved);
  const manifest = params.manifest ?? null;
  params.candidates.push({
    idHint: params.idHint,
    source: resolved,
    rootDir: path.resolve(params.rootDir),
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    packageName: manifest?.name?.trim() || undefined,
    packageVersion: manifest?.version?.trim() || undefined,
    packageDescription: manifest?.description?.trim() || undefined,
    packageDir: params.packageDir,
    packageMoltbot: getPackageManifestMetadata(manifest ?? undefined),
  });
}

function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
      level: "warn",
      message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
      source: params.dir,
    });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(params.dir, entry.name);
    if (entry.isFile()) {
      if (!isExtensionFile(fullPath)) continue;
      addCandidate({
        candidates: params.candidates,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        workspaceDir: params.workspaceDir,
      });
    }
    if (!entry.isDirectory()) continue;

    const manifest = readPackageManifest(fullPath);
    const extensions = manifest ? resolvePackageExtensions(manifest) : [];

    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const resolved = path.resolve(fullPath, extPath);
        addCandidate({
          candidates: params.candidates,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          rootDir: fullPath,
          origin: params.origin,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
        });
      }
      continue;
    }

    const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
    const indexFile = indexCandidates
      .map((candidate) => path.join(fullPath, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        seen: params.seen,
        idHint: entry.name,
        source: indexFile,
        rootDir: fullPath,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
      });
    }
  }
}

function discoverFromPath(params: {
  rawPath: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
}) {
  const resolved = resolveUserPath(params.rawPath);
  if (!fs.existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    addCandidate({
      candidates: params.candidates,
      seen: params.seen,
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      workspaceDir: params.workspaceDir,
    });
    return;
  }

  if (stat.isDirectory()) {
    const manifest = readPackageManifest(resolved);
    const extensions = manifest ? resolvePackageExtensions(manifest) : [];

    if (extensions.length > 0) {
      for (const extPath of extensions) {
        const source = path.resolve(resolved, extPath);
        addCandidate({
          candidates: params.candidates,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          rootDir: resolved,
          origin: params.origin,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
        });
      }
      return;
    }

    const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
    const indexFile = indexCandidates
      .map((candidate) => path.join(resolved, candidate))
      .find((candidate) => fs.existsSync(candidate));

    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        seen: params.seen,
        idHint: path.basename(resolved),
        source: indexFile,
        rootDir: resolved,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
      });
      return;
    }

    discoverInDirectory({
      dir: resolved,
      origin: params.origin,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
    });
    return;
  }
}

export function discoverMoltbotPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
}): PluginDiscoveryResult {
  const candidates: PluginCandidate[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const seen = new Set<string>();
  const workspaceDir = params.workspaceDir?.trim();

  const extra = params.extraPaths ?? [];
  for (const extraPath of extra) {
    if (typeof extraPath !== "string") continue;
    const trimmed = extraPath.trim();
    if (!trimmed) continue;
    discoverFromPath({
      rawPath: trimmed,
      origin: "config",
      workspaceDir: workspaceDir?.trim() || undefined,
      candidates,
      diagnostics,
      seen,
    });
  }
  if (workspaceDir) {
    const workspaceRoot = resolveUserPath(workspaceDir);
    const workspaceExt = path.join(workspaceRoot, ".clawdbot", "extensions");
    discoverInDirectory({
      dir: workspaceExt,
      origin: "workspace",
      workspaceDir: workspaceRoot,
      candidates,
      diagnostics,
      seen,
    });
  }

  const globalDir = path.join(resolveConfigDir(), "extensions");
  discoverInDirectory({
    dir: globalDir,
    origin: "global",
    candidates,
    diagnostics,
    seen,
  });

  const bundledDir = resolveBundledPluginsDir();
  if (bundledDir) {
    discoverInDirectory({
      dir: bundledDir,
      origin: "bundled",
      candidates,
      diagnostics,
      seen,
    });
  }

  return { candidates, diagnostics };
}
