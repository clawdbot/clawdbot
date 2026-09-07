// Pre-action policy for `plugins install`: decide whether an install may bypass invalid
// config so plugin-owned doctor/recovery code can repair broken plugin state.
import fs from "node:fs";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { Command } from "commander";
import { tryReadJsonSync } from "../infra/json-files.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
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

/** Parsed install request plus recovery metadata needed by CLI pre-action config policy. */
export type PluginInstallRequestContext = {
  rawSpec: string;
  normalizedSpec: string;
  installKind?: "plugin";
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

function readPluginInstallRecoveryMetadata(rootDir: string): {
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

function resolvePluginInstallRecoveryMetadata(
  rawSpec: string,
  localPath: string | undefined,
): {
  pluginId?: string;
  allowInvalidConfigRecovery?: boolean;
} {
  // A local or file: request must never inherit recovery authority from a catalog name.
  if (localPath !== undefined) {
    const direct = readPluginInstallRecoveryMetadata(localPath);
    return direct.pluginId || direct.allowInvalidConfigRecovery ? direct : {};
  }
  const npmPrefixSpec = parseNpmPrefixSpec(rawSpec);
  const values = new Set(
    normalizeStringEntries([
      rawSpec,
      npmPrefixSpec ?? "",
      parseRegistryNpmSpec(rawSpec)?.name ?? "",
      npmPrefixSpec ? parseRegistryNpmSpec(npmPrefixSpec)?.name : "",
    ]),
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
    // An official descriptor owns this decision even when recovery is explicitly disabled.
    return {
      ...(pluginId ? { pluginId } : {}),
      allowInvalidConfigRecovery: install?.allowInvalidConfigRecovery === true,
    };
  }
  for (const value of [rawSpec.trim(), npmPrefixSpec ?? ""]) {
    if (!value) {
      continue;
    }
    const bundled = findBundledPluginSource({ lookup: { kind: "npmSpec", value } });
    if (bundled) {
      const recovered = readPluginInstallRecoveryMetadata(bundled.localPath);
      return {
        pluginId: recovered.pluginId ?? bundled.pluginId,
        allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery,
      };
    }
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
    const token = tokens.at(index);
    if (token === undefined) {
      break;
    }
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

/** Resolve install metadata from the raw spec before Commander action handlers mutate config. */
export function resolvePluginInstallRequestContext(params: {
  rawSpec: string;
  marketplace?: string;
  installKind?: "plugin";
}): PluginInstallRequestResolution {
  if (params.marketplace) {
    return {
      ok: true,
      request: {
        rawSpec: params.rawSpec,
        normalizedSpec: params.rawSpec,
        installKind: "plugin",
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
  const resolvedPath = resolveUserPath(normalizedSpec);
  const localPath = fileSpec || fs.existsSync(resolvedPath) ? resolvedPath : undefined;
  const recovered = resolvePluginInstallRecoveryMetadata(params.rawSpec, localPath);
  return {
    ok: true,
    request: {
      rawSpec: params.rawSpec,
      normalizedSpec,
      resolvedPath,
      ...(params.installKind === "plugin" || recovered.pluginId ? { installKind: "plugin" } : {}),
      ...(recovered.pluginId ? { bundledPluginId: recovered.pluginId } : {}),
      ...(recovered.allowInvalidConfigRecovery !== undefined
        ? { allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery }
        : {}),
    },
  };
}

/** Recover the plugin install request from Commander state plus raw argv fallback parsing. */
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

/** Decide whether invalid config should block a command before plugin recovery can run. */
export function resolvePluginInstallInvalidConfigPolicy(
  request: PluginInstallRequestContext | null,
): PluginInstallInvalidConfigPolicy {
  if (!request) {
    return "deny";
  }
  return request.allowInvalidConfigRecovery === true ? "allow-plugin-recovery" : "deny";
}
