import fs from "node:fs";

import type { MoltbotConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "./config-state.js";
import { discoverMoltbotPlugins, type PluginCandidate } from "./discovery.js";
import { loadPluginManifest, type PluginManifest } from "./manifest.js";
import type { PluginConfigUiHint, PluginDiagnostic, PluginKind, PluginOrigin } from "./types.js";

export type PluginManifestRecord = {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: PluginKind;
  channels: string[];
  providers: string[];
  skills: string[];
  origin: PluginOrigin;
  workspaceDir?: string;
  rootDir: string;
  source: string;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
  configUiHints?: Record<string, PluginConfigUiHint>;
};

export type PluginManifestRegistry = {
  plugins: PluginManifestRecord[];
  diagnostics: PluginDiagnostic[];
};

const registryCache = new Map<string, { expiresAt: number; registry: PluginManifestRegistry }>();

const DEFAULT_MANIFEST_CACHE_MS = 200;

function resolveManifestCacheMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CLAWDBOT_PLUGIN_MANIFEST_CACHE_MS?.trim();
  if (raw === "" || raw === "0") return 0;
  if (!raw) return DEFAULT_MANIFEST_CACHE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MANIFEST_CACHE_MS;
  return Math.max(0, parsed);
}

function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
  const disabled = env.CLAWDBOT_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
  if (disabled) return false;
  return resolveManifestCacheMs(env) > 0;
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
}): string {
  const workspaceKey = params.workspaceDir ? resolveUserPath(params.workspaceDir) : "";
  return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

function safeStatMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function normalizeManifestLabel(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function buildRecord(params: {
  manifest: PluginManifest;
  candidate: PluginCandidate;
  manifestPath: string;
  schemaCacheKey?: string;
  configSchema?: Record<string, unknown>;
}): PluginManifestRecord {
  return {
    id: params.manifest.id,
    name: normalizeManifestLabel(params.manifest.name) ?? params.candidate.packageName,
    description:
      normalizeManifestLabel(params.manifest.description) ?? params.candidate.packageDescription,
    version: normalizeManifestLabel(params.manifest.version) ?? params.candidate.packageVersion,
    kind: params.manifest.kind,
    channels: params.manifest.channels ?? [],
    providers: params.manifest.providers ?? [],
    skills: params.manifest.skills ?? [],
    origin: params.candidate.origin,
    workspaceDir: params.candidate.workspaceDir,
    rootDir: params.candidate.rootDir,
    source: params.candidate.source,
    manifestPath: params.manifestPath,
    schemaCacheKey: params.schemaCacheKey,
    configSchema: params.configSchema,
    configUiHints: params.manifest.uiHints,
  };
}

export function loadPluginManifestRegistry(params: {
  config?: MoltbotConfig;
  workspaceDir?: string;
  cache?: boolean;
  env?: NodeJS.ProcessEnv;
  candidates?: PluginCandidate[];
  diagnostics?: PluginDiagnostic[];
}): PluginManifestRegistry {
  const config = params.config ?? {};
  const normalized = normalizePluginsConfig(config.plugins);
  const cacheKey = buildCacheKey({ workspaceDir: params.workspaceDir, plugins: normalized });
  const env = params.env ?? process.env;
  const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
  if (cacheEnabled) {
    const cached = registryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.registry;
  }

  const discovery = params.candidates
    ? {
        candidates: params.candidates,
        diagnostics: params.diagnostics ?? [],
      }
    : discoverMoltbotPlugins({
        workspaceDir: params.workspaceDir,
        extraPaths: normalized.loadPaths,
      });
  const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
  const candidates: PluginCandidate[] = discovery.candidates;
  const records: PluginManifestRecord[] = [];
  const seenIds = new Set<string>();

  for (const candidate of candidates) {
    const manifestRes = loadPluginManifest(candidate.rootDir);
    if (!manifestRes.ok) {
      diagnostics.push({
        level: "error",
        message: manifestRes.error,
        source: manifestRes.manifestPath,
      });
      continue;
    }
    const manifest = manifestRes.manifest;

    if (candidate.idHint && candidate.idHint !== manifest.id) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `plugin id mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`,
      });
    }

    if (seenIds.has(manifest.id)) {
      diagnostics.push({
        level: "warn",
        pluginId: manifest.id,
        source: candidate.source,
        message: `duplicate plugin id detected; later plugin may be overridden (${candidate.source})`,
      });
    } else {
      seenIds.add(manifest.id);
    }

    const configSchema = manifest.configSchema;
    const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
    const schemaCacheKey = manifestMtime
      ? `${manifestRes.manifestPath}:${manifestMtime}`
      : manifestRes.manifestPath;

    records.push(
      buildRecord({
        manifest,
        candidate,
        manifestPath: manifestRes.manifestPath,
        schemaCacheKey,
        configSchema,
      }),
    );
  }

  const registry = { plugins: records, diagnostics };
  if (cacheEnabled) {
    const ttl = resolveManifestCacheMs(env);
    if (ttl > 0) {
      registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
    }
  }
  return registry;
}
