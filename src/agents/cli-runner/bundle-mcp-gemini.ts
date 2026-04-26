import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import {
  applyCommonServerConfig,
  decodeHeaderEnvPlaceholder,
  isRecord,
  normalizeStringRecord,
} from "./bundle-mcp-adapter-shared.js";

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? ({ ...raw } as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function resolveEnvPlaceholder(
  value: string,
  inheritedEnv: Record<string, string> | undefined,
): string {
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
  const next: Record<string, unknown> = {};
  applyCommonServerConfig(next, server);
  if (typeof server.type === "string") {
    next.type = server.type;
  }
  const headers = normalizeStringRecord(server.headers);
  if (headers) {
    next.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        resolveEnvPlaceholder(value, inheritedEnv),
      ]),
    );
  }
  if (typeof server.trust === "boolean") {
    next.trust = server.trust;
  }
  return next;
}

export async function writeGeminiSystemSettings(
  mergedConfig: BundleMcpConfig,
  inheritedEnv: Record<string, string> | undefined,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gemini-mcp-"));
  const settingsPath = path.join(tempDir, "settings.json");
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
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  return {
    env: {
      ...inheritedEnv,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
    },
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}
