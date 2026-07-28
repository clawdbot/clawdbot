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
  normalizeStringRecord,
} from "../bundle-mcp-adapter.js";
import { withOpenClawMcpCaptureHeader, writeTemporaryBundleMcpJson } from "./bundle-mcp-runtime.js";

const GEMINI_MCP_SERVER_FIELDS = { strings: ["type"], booleans: ["trust"] } as const;

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const raw = await tryReadJson<unknown>(filePath);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? ({ ...raw } as Record<string, unknown>)
    : {};
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
): Record<string, unknown> {
  const next = normalizeBundleMcpServerConfig(server, GEMINI_MCP_SERVER_FIELDS);
  const headers = normalizeStringRecord(server.headers);
  if (headers) {
    next.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        resolveEnvPlaceholder(value, inheritedEnv),
      ]),
    );
  }
  return next;
}

/** Writes merged Gemini system settings and returns env plus cleanup hook. */
export async function writeGeminiSystemSettings(
  mergedConfig: BundleMcpConfig,
  inheritedEnv: Record<string, string> | undefined,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const existingSettingsPath =
    inheritedEnv?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  const base =
    typeof existingSettingsPath === "string" && existingSettingsPath.trim()
      ? await readJsonObject(existingSettingsPath)
      : {};
  const normalizedConfig: BundleMcpConfig = {
    mcpServers: Object.fromEntries(
      Object.entries(mergedConfig.mcpServers).map(([name, server]) => [
        name,
        normalizeGeminiServerConfig(server, inheritedEnv),
      ]),
    ) as BundleMcpConfig["mcpServers"],
  };
  const settings = applyMergePatch(base, {
    mcp: {
      allowed: Object.keys(normalizedConfig.mcpServers),
    },
    mcpServers: normalizedConfig.mcpServers,
  }) as Record<string, unknown>;
  if (!isRecord(settings.mcp) || !isRecord(settings.mcpServers)) {
    throw new Error("Gemini MCP settings merge produced an invalid object");
  }
  const temporary = await writeTemporaryBundleMcpJson("openclaw-gemini-mcp-", settings);
  return {
    env: {
      ...inheritedEnv,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: temporary.filePath,
    },
    cleanup: temporary.cleanup,
  };
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
