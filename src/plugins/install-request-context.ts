// Pre-action policy for `plugins install`: decide whether an install may bypass invalid
// config so plugin-owned doctor/recovery code can repair broken plugin state.
import fs from "node:fs";
import path from "node:path";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { tryReadJsonSync } from "../infra/json-files.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import { findBundledPluginSource } from "./bundled-sources.js";
import { parseNpmPrefixSpec, resolveFileNpmSpecToLocalPath } from "./install-source-spec.js";
import { loadPluginManifest } from "./manifest.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

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

function resolvePluginInstallRecoveryMetadata(
  rawSpec: string,
  localPath: string | undefined,
): {
  pluginId?: string;
  allowInvalidConfigRecovery?: boolean;
} {
  // A local or file: request must never inherit recovery authority from a catalog name.
  if (localPath !== undefined) {
    const direct = readBundledInstallRecoveryMetadata(localPath);
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
      const recovered = readBundledInstallRecoveryMetadata(bundled.localPath);
      return {
        pluginId: recovered.pluginId ?? bundled.pluginId,
        allowInvalidConfigRecovery: recovered.allowInvalidConfigRecovery,
      };
    }
  }
  return {};
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
    return fileSpec;
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

/** Decide whether invalid config should block a command before plugin recovery can run. */
export function resolvePluginInstallInvalidConfigPolicy(
  request: PluginInstallRequestContext | null,
): PluginInstallInvalidConfigPolicy {
  if (!request) {
    return "deny";
  }
  return request.allowInvalidConfigRecovery === true ? "allow-plugin-recovery" : "deny";
}
