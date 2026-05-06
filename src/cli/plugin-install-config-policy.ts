import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { tryReadJsonSync } from "../infra/json-files.js";
import { findBundledPluginSource } from "../plugins/bundled-sources.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../plugins/official-external-plugin-catalog.js";
import { resolveUserPath } from "../utils.js";
import { parseNpmPrefixSpec, resolveFileNpmSpecToLocalPath } from "./plugins-command-helpers.js";

type PluginInstallInvalidConfigPolicy = "deny" | "allow-plugin-recovery";

export type PluginInstallRequestContext = {
  rawSpec: string;
  normalizedSpec: string;
  resolvedPath?: string;
  marketplace?: string;
  bundledPluginId?: string;
  allowInvalidConfigRecovery?: boolean;
};

type PluginInstallRequestResolution =
  | { ok: true; request: PluginInstallRequestContext }
  | { ok: false; error: string };

function isPluginInstallCommand(commandPath: string[]): boolean {
  return commandPath[0] === "plugins" && commandPath[1] === "install";
}

function readBundledInstallRecoveryMetadata(rootDir: string): {
  pluginId?: string;
  allowInvalidConfigRecovery: boolean;
} {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { allowInvalidConfigRecovery: false };
  }
  const manifest = loadPluginManifest(rootDir, false);
  const pluginId = manifest.ok ? manifest.manifest.id : undefined;
  const parsed = tryReadJsonSync<{
    openclaw?: {
      install?: {
        allowInvalidConfigRecovery?: boolean;
      };
    };
  }>(packageJsonPath);
  return {
    ...(pluginId ? { pluginId } : {}),
    allowInvalidConfigRecovery: parsed?.openclaw?.install?.allowInvalidConfigRecovery === true,
  };
}

function resolveBundledInstallRecoveryMetadata(
  request: Pick<
    PluginInstallRequestContext,
    "rawSpec" | "normalizedSpec" | "resolvedPath" | "marketplace"
  >,
): {
  pluginId?: string;
  allowInvalidConfigRecovery?: boolean;
} {
  if (request.marketplace) {
    return {};
  }
  if (request.resolvedPath && fs.existsSync(path.join(request.resolvedPath, "package.json"))) {
    const direct = readBundledInstallRecoveryMetadata(request.resolvedPath);
    if (direct.pluginId || direct.allowInvalidConfigRecovery) {
      return direct;
    }
  }
  const rawNpmPrefixSpec = parseNpmPrefixSpec(request.rawSpec);
  const normalizedNpmPrefixSpec = parseNpmPrefixSpec(request.normalizedSpec);
  for (const value of [
    request.rawSpec.trim(),
    request.normalizedSpec.trim(),
    rawNpmPrefixSpec ?? "",
    normalizedNpmPrefixSpec ?? "",
  ]) {
    if (!value) {
      continue;
    }
    const bundled = findBundledPluginSource({
      lookup: { kind: "npmSpec", value },
    });
    if (!bundled) {
      continue;
    }
    const recovered = readBundledInstallRecoveryMetadata(bundled.localPath);
    return {
      pluginId: recovered.pluginId ?? bundled.pluginId,
      allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery,
    };
  }
  return {};
}

function resolveOfficialExternalInstallRecoveryMetadata(
  request: Pick<PluginInstallRequestContext, "rawSpec" | "normalizedSpec" | "marketplace">,
): {
  pluginId?: string;
  allowInvalidConfigRecovery?: boolean;
} {
  if (request.marketplace) {
    return {};
  }
  const rawNpmPrefixSpec = parseNpmPrefixSpec(request.rawSpec);
  const normalizedNpmPrefixSpec = parseNpmPrefixSpec(request.normalizedSpec);
  const values = new Set(
    [request.rawSpec, request.normalizedSpec, rawNpmPrefixSpec ?? "", normalizedNpmPrefixSpec ?? ""]
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (values.size === 0) {
    return {};
  }
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const install = resolveOfficialExternalPluginInstall(entry);
    const npmSpec = install?.npmSpec?.trim() || entry.name?.trim();
    if (!npmSpec || !values.has(npmSpec)) {
      continue;
    }
    const pluginId = resolveOfficialExternalPluginId(entry);
    return {
      ...(pluginId ? { pluginId } : {}),
      allowInvalidConfigRecovery: install?.allowInvalidConfigRecovery === true,
    };
  }
  return {};
}

function resolvePluginInstallArgvTokens(commandPath: string[], argv: string[]): string[] {
  const args = argv.slice(2);
  let cursor = 0;
  for (const segment of commandPath) {
    while (cursor < args.length && args[cursor] !== segment) {
      cursor += 1;
    }
    if (cursor >= args.length) {
      return [];
    }
    cursor += 1;
  }
  return args.slice(cursor);
}

function resolvePluginInstallArgvRequest(commandPath: string[], argv: string[]) {
  if (!isPluginInstallCommand(commandPath)) {
    return null;
  }
  const tokens = resolvePluginInstallArgvTokens(commandPath, argv);
  let rawSpec: string | null = null;
  let marketplace: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--marketplace=")) {
      marketplace = token.slice("--marketplace=".length);
      continue;
    }
    if (token === "--marketplace") {
      const value = tokens[index + 1];
      if (typeof value === "string") {
        marketplace = value;
        index += 1;
      }
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    rawSpec ??= token;
  }
  return rawSpec ? { rawSpec, marketplace } : null;
}

export function resolvePluginInstallRequestContext(params: {
  rawSpec: string;
  marketplace?: string;
}): PluginInstallRequestResolution {
  if (params.marketplace) {
    return {
      ok: true,
      request: {
        rawSpec: params.rawSpec,
        normalizedSpec: params.rawSpec,
        marketplace: params.marketplace,
      },
    };
  }
  const fileSpec = resolveFileNpmSpecToLocalPath(params.rawSpec);
  if (fileSpec && !fileSpec.ok) {
    return {
      ok: false,
      error: fileSpec.error,
    };
  }
  const normalizedSpec = fileSpec && fileSpec.ok ? fileSpec.path : params.rawSpec;
  const bundledRecovered = resolveBundledInstallRecoveryMetadata({
    rawSpec: params.rawSpec,
    normalizedSpec,
    resolvedPath: resolveUserPath(normalizedSpec),
    marketplace: params.marketplace,
  });
  const officialRecovered = resolveOfficialExternalInstallRecoveryMetadata({
    rawSpec: params.rawSpec,
    normalizedSpec,
    marketplace: params.marketplace,
  });
  const recovered =
    officialRecovered.pluginId || officialRecovered.allowInvalidConfigRecovery !== undefined
      ? officialRecovered
      : bundledRecovered;
  return {
    ok: true,
    request: {
      rawSpec: params.rawSpec,
      normalizedSpec,
      resolvedPath: resolveUserPath(normalizedSpec),
      ...(recovered.pluginId ? { bundledPluginId: recovered.pluginId } : {}),
      ...(recovered.allowInvalidConfigRecovery !== undefined
        ? { allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery }
        : {}),
    },
  };
}

export function resolvePluginInstallPreactionRequest(params: {
  actionCommand: Command;
  commandPath: string[];
  argv: string[];
}): PluginInstallRequestContext | null {
  if (!isPluginInstallCommand(params.commandPath)) {
    return null;
  }
  const argvRequest = resolvePluginInstallArgvRequest(params.commandPath, params.argv);
  const opts = params.actionCommand.opts<Record<string, unknown>>();
  const marketplace =
    (typeof opts.marketplace === "string" && opts.marketplace.trim()
      ? opts.marketplace
      : argvRequest?.marketplace) || undefined;
  const rawSpec =
    (typeof params.actionCommand.processedArgs?.[0] === "string"
      ? params.actionCommand.processedArgs[0]
      : argvRequest?.rawSpec) ?? null;
  if (!rawSpec) {
    return null;
  }
  const request = resolvePluginInstallRequestContext({ rawSpec, marketplace });
  return request.ok ? request.request : null;
}

export function resolvePluginInstallInvalidConfigPolicy(
  request: PluginInstallRequestContext | null,
): PluginInstallInvalidConfigPolicy {
  if (!request) {
    return "deny";
  }
  return request.allowInvalidConfigRecovery === true ? "allow-plugin-recovery" : "deny";
}
