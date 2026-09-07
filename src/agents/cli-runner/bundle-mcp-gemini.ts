/**
 * Gemini CLI bundle MCP adapter that writes temporary system settings files.
 */
import { applyMergePatch } from "../../config/merge-patch.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import {
  decodeHeaderEnvPlaceholder,
  isRecord,
  normalizeBundleMcpServerConfig,
  normalizeMcpStringRecord,
} from "../bundle-mcp-adapter.js";
import { withOpenClawMcpCaptureHeader, writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

const GEMINI_MCP_SERVER_FIELDS = { strings: ["type"], booleans: ["trust"] } as const;

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const raw = await tryReadJson<unknown>(filePath);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? ({ ...raw } as Record<string, unknown>)
    : {};
}

async function readGeminiBaseSettings(
  inheritedEnv: Record<string, string> | undefined,
): Promise<Record<string, unknown>> {
  const settingsPath =
    inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  return typeof settingsPath === "string" && settingsPath.trim()
    ? await readJsonObject(settingsPath)
    : {};
}

function mergeGeminiWebSearchDisabled(base: Record<string, unknown>): Record<string, unknown> {
  const existing =
    isRecord(base.tools) && Array.isArray(base.tools.exclude)
      ? base.tools.exclude.filter((name): name is string => typeof name === "string")
      : [];
  return applyMergePatch(base, {
    tools: { exclude: [...new Set([...existing, "google_web_search"])] },
  }) as Record<string, unknown>;
}

async function writeGeminiSettings(
  settings: Record<string, unknown>,
  inheritedEnv: Record<string, string> | undefined,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const temporary = await writeTemporaryBundleMcpJson("openclaw-gemini-mcp-", settings);
  return {
    env: { ...inheritedEnv, GEMINI_CLI_SYSTEM_SETTINGS_PATH: temporary.filePath },
    cleanup: temporary.cleanup,
  };
}

export async function writeGeminiWebSearchDisabledSettings(
  inheritedEnv: Record<string, string> | undefined,
) {
  return await writeGeminiSettings(
    mergeGeminiWebSearchDisabled(await readGeminiBaseSettings(inheritedEnv)),
    inheritedEnv,
  );
}

function resolveEnvPlaceholder(
  value: string,
  inheritedEnv: Record<string, string> | undefined,
): string {
  // Gemini settings need concrete header values; resolve placeholders from the
  // inherited run env first, then the process env.
  const decoded = decodeHeaderEnvPlaceholder(value);
  if (!decoded) {
    return value;
  }
  const resolved = inheritedEnv?.[decoded.envVar] ?? process.env[decoded.envVar] ?? "";
  return decoded.bearer ? `Bearer ${resolved}` : resolved;
}

function normalizeGeminiServerConfig(
  server: BundleMcpServerConfig,
  inheritedEnv: Record<string, string> | undefined,
  deniedTools: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  const next = normalizeBundleMcpServerConfig(server, GEMINI_MCP_SERVER_FIELDS);
  const headers = normalizeMcpStringRecord(server.headers);
  if (headers) {
    next.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        resolveEnvPlaceholder(value, inheritedEnv),
      ]),
    );
  }
  const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
  const included = Array.isArray(toolFilter.include)
    ? toolFilter.include.filter((name): name is string => typeof name === "string")
    : [];
  if (included.length > 0) {
    const existing = Array.isArray(server.includeTools)
      ? server.includeTools.filter((name): name is string => typeof name === "string")
      : [];
    const finalIncluded =
      existing.length > 0
        ? included.filter((name) => existing.includes(name)).toSorted()
        : [...new Set(included)].toSorted();
    if (finalIncluded.length === 0) {
      return undefined;
    }
    next.includeTools = finalIncluded;
  }
  const filteredDenied = Array.isArray(toolFilter.exclude)
    ? toolFilter.exclude.filter((name): name is string => typeof name === "string")
    : [];
  if (deniedTools?.length || filteredDenied.length > 0) {
    const existing = Array.isArray(server.excludeTools)
      ? server.excludeTools.filter((name): name is string => typeof name === "string")
      : [];
    next.excludeTools = [
      ...new Set([...existing, ...filteredDenied, ...(deniedTools ?? [])]),
    ].toSorted();
  }
  return next;
}

/** Writes merged Gemini system settings and returns env plus cleanup hook. */
export async function writeGeminiSystemSettings(
  mergedConfig: BundleMcpConfig,
  inheritedEnv: Record<string, string> | undefined,
  mcpToolsDeny?: Record<string, string[]>,
  webSearchEnabled?: boolean,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const base = await readGeminiBaseSettings(inheritedEnv);
  const normalizedConfig: BundleMcpConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(mergedConfig.mcpServers).flatMap(([name, server]) => {
        const normalized = normalizeGeminiServerConfig(
          server,
          inheritedEnv,
          mcpToolsDeny && Object.hasOwn(mcpToolsDeny, name) ? mcpToolsDeny[name] : undefined,
        );
        return normalized ? [[name, normalized]] : [];
      }),
    ) as BundleMcpConfig["mcpServers"],
  };
  const settings = applyMergePatch(
    webSearchEnabled === false ? mergeGeminiWebSearchDisabled(base) : base,
    {
      mcp: {
        allowed: Object.keys(normalizedConfig.mcpServers),
      },
      mcpServers: normalizedConfig.mcpServers,
    },
  ) as Record<string, unknown>;
  if (!isRecord(settings.mcp) || !isRecord(settings.mcpServers)) {
    throw new Error("Gemini MCP settings merge produced an invalid object");
  }
  return await writeGeminiSettings(settings, inheritedEnv);
}

/** Writes per-attempt Gemini settings with the active loopback capture token. */
export async function writeGeminiMcpCaptureSettings(params: {
  inheritedEnv: Record<string, string> | undefined;
  captureKey: string;
}): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const existingSettingsPath = params.inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (!existingSettingsPath) {
    throw new Error("Gemini MCP capture requires prepared system settings");
  }
  const settings = await readJsonObject(existingSettingsPath);
  const temporary = await writeTemporaryBundleMcpJson(
    "openclaw-gemini-mcp-attempt-",
    withOpenClawMcpCaptureHeader(settings, params.captureKey),
  );
  return {
    env: {
      ...params.inheritedEnv,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: temporary.filePath,
    },
    cleanup: temporary.cleanup,
  };
}
