import fs from "node:fs/promises";
import path from "node:path";
import {
  type CodexAppInventoryCache,
  type CodexAppInventoryRequest,
} from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME, type ResolvedCodexPluginPolicy } from "./config.js";
import {
  findOpenAiCuratedPluginSummary,
  pluginReadParams,
  type CodexPluginMarketplaceRef,
  type CodexPluginRuntimeRequest,
} from "./plugin-inventory.js";
import type { v2 } from "./protocol.js";

export type CodexPluginActivationReason =
  | "already_active"
  | "installed"
  | "disabled"
  | "marketplace_missing"
  | "plugin_missing"
  | "auth_required"
  | "refresh_failed";

export type CodexPluginActivationDiagnostic = {
  message: string;
};

export type CodexPluginActivationResult = {
  identity: ResolvedCodexPluginPolicy;
  ok: boolean;
  reason: CodexPluginActivationReason;
  installAttempted: boolean;
  marketplace?: CodexPluginMarketplaceRef;
  installResponse?: v2.PluginInstallResponse;
  diagnostics: CodexPluginActivationDiagnostic[];
};

export type EnsureCodexPluginActivationParams = {
  identity: ResolvedCodexPluginPolicy;
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
  installEvenIfActive?: boolean;
};

export type CodexPluginRuntimeRefreshResult = {
  diagnostics: CodexPluginActivationDiagnostic[];
};

export async function ensureCodexPluginActivation(
  params: EnsureCodexPluginActivationParams,
): Promise<CodexPluginActivationResult> {
  if (params.identity.marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME) {
    return activationFailure(params.identity, "marketplace_missing", {
      message: "Only " + CODEX_PLUGINS_MARKETPLACE_NAME + " plugins can be activated.",
    });
  }

  const listed = (await params.request("plugin/list", {
    cwds: [],
  } satisfies v2.PluginListParams)) as v2.PluginListResponse;
  const resolved = findOpenAiCuratedPluginSummary(listed, params.identity.pluginName);
  if (!resolved) {
    return activationFailure(params.identity, "plugin_missing", {
      message: `${params.identity.pluginName} was not found in ${CODEX_PLUGINS_MARKETPLACE_NAME}.`,
    });
  }

  if (resolved.summary.installed && resolved.summary.enabled && !params.installEvenIfActive) {
    return {
      identity: params.identity,
      ok: true,
      reason: "already_active",
      installAttempted: false,
      marketplace: resolved.marketplace,
      diagnostics: [],
    };
  }

  const installResponse = (await params.request(
    "plugin/install",
    pluginReadParams(
      resolved.marketplace,
      params.identity.pluginName,
    ) satisfies v2.PluginInstallParams,
  )) as v2.PluginInstallResponse;
  const refreshDiagnostics: CodexPluginActivationDiagnostic[] = [];
  let refreshFailed = false;
  try {
    const refreshResult = await refreshCodexPluginRuntimeState({
      request: params.request,
      appCache: params.appCache,
      appCacheKey: params.appCacheKey,
    });
    refreshDiagnostics.push(...refreshResult.diagnostics);
  } catch (error) {
    refreshFailed = true;
    refreshDiagnostics.push({
      message: `Codex plugin runtime refresh failed after install: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  const authRequired = installResponse.appsNeedingAuth.length > 0;
  return {
    identity: params.identity,
    ok: !authRequired && !refreshFailed,
    reason: refreshFailed
      ? "refresh_failed"
      : authRequired
        ? "auth_required"
        : resolved.summary.installed && resolved.summary.enabled
          ? "already_active"
          : "installed",
    installAttempted: true,
    marketplace: resolved.marketplace,
    installResponse,
    diagnostics: [
      ...refreshDiagnostics,
      ...installResponse.appsNeedingAuth.map((app) => ({
        message: `${app.name} requires app authentication before plugin tools are exposed.`,
      })),
    ],
  };
}

export async function refreshCodexPluginRuntimeState(params: {
  request: CodexPluginRuntimeRequest;
  appCache?: CodexAppInventoryCache;
  appCacheKey?: string;
}): Promise<CodexPluginRuntimeRefreshResult> {
  const diagnostics: CodexPluginActivationDiagnostic[] = [];
  await params.request("plugin/list", {
    cwds: [],
  } satisfies v2.PluginListParams);
  await params.request("skills/list", {
    cwds: [],
    forceReload: true,
  } satisfies v2.SkillsListParams);
  try {
    await params.request("hooks/list", {
      cwds: [],
    } satisfies v2.HooksListParams);
  } catch (error) {
    diagnostics.push({
      message: `Codex hooks refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  await params.request("config/mcpServer/reload", undefined);

  if (params.appCache && params.appCacheKey) {
    params.appCache.invalidate(params.appCacheKey, "Codex plugin activation changed app inventory");
    const request: CodexAppInventoryRequest = async (method, requestParams) =>
      (await params.request(method, requestParams)) as v2.AppsListResponse;
    try {
      await params.appCache.refreshNow({
        key: params.appCacheKey,
        request,
        forceRefetch: true,
      });
    } catch (error) {
      diagnostics.push({
        message: `Codex app inventory refresh skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  return { diagnostics };
}

export async function ensureCodexAppsSubstrateConfig(params: {
  codexHome: string;
  readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  writeFile?: (filePath: string, content: string, encoding: "utf8") => Promise<void>;
  mkdir?: (dirPath: string, options: { recursive: true }) => Promise<unknown>;
}): Promise<{ changed: boolean; configPath: string }> {
  const readFile = params.readFile ?? ((filePath, encoding) => fs.readFile(filePath, encoding));
  const writeFile =
    params.writeFile ??
    ((filePath, content, encoding) => fs.writeFile(filePath, content, encoding));
  const mkdir = params.mkdir ?? ((dirPath, options) => fs.mkdir(dirPath, options));
  const configPath = path.join(params.codexHome, "config.toml");
  let current = "";
  try {
    current = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const next = upsertTomlBoolean(
    upsertTomlBoolean(current, "features", "apps", true),
    "apps._default",
    "enabled",
    true,
  );
  if (next === current) {
    return { changed: false, configPath };
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, next, "utf8");
  return { changed: true, configPath };
}

export function upsertTomlBoolean(
  source: string,
  section: string,
  key: string,
  value: boolean,
): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const sectionHeaderPattern = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`);
  const anySectionPattern = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const desiredLine = `${key} = ${value ? "true" : "false"}`;
  const sectionStart = lines.findIndex((line) => sectionHeaderPattern.test(line));
  if (sectionStart === -1) {
    const nextLines = [...lines];
    if (nextLines.length > 0 && nextLines.at(-1)?.trim()) {
      nextLines.push("");
    }
    nextLines.push(`[${section}]`, desiredLine);
    return `${nextLines.join("\n")}\n`;
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (anySectionPattern.test(lines[index] ?? "")) {
      sectionEnd = index;
      break;
    }
  }
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    if (keyPattern.test(lines[index] ?? "")) {
      if (lines[index] === desiredLine) {
        return `${lines.join("\n")}\n`;
      }
      const nextLines = [...lines];
      nextLines[index] = desiredLine;
      return `${nextLines.join("\n")}\n`;
    }
  }
  const nextLines = [...lines];
  nextLines.splice(sectionEnd, 0, desiredLine);
  return `${nextLines.join("\n")}\n`;
}

function activationFailure(
  identity: ResolvedCodexPluginPolicy,
  reason: CodexPluginActivationReason,
  diagnostic: CodexPluginActivationDiagnostic,
): CodexPluginActivationResult {
  return {
    identity,
    ok: false,
    reason,
    installAttempted: false,
    diagnostics: [diagnostic],
  };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
