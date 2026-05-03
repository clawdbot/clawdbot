import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveMemoryDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { asRecord } from "./dreaming-shared.js";
import { resolveShortTermPromotionDreamingConfig } from "./dreaming.js";

function resolveMemoryCorePluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  return asRecord(entry?.config) ?? {};
}

function updateDreamingEnabledInConfig(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
  const entries = { ...cfg.plugins?.entries };
  const existingEntry = asRecord(entries["memory-core"]) ?? {};
  const existingConfig = asRecord(existingEntry.config) ?? {};
  const existingSleep = asRecord(existingConfig.dreaming) ?? {};
  entries["memory-core"] = {
    ...existingEntry,
    config: {
      ...existingConfig,
      dreaming: {
        ...existingSleep,
        enabled,
      },
    },
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries,
    },
  };
}

function formatEnabled(value: boolean): string {
  return value ? "on" : "off";
}

function formatPhaseGuide(): string {
  return [
    "- implementation detail: each sweep runs light -> REM -> deep.",
    "- deep is the only stage that writes durable entries to MEMORY.md.",
    "- DREAMS.md is for human-readable dreaming summaries and diary entries.",
  ].join("\n");
}

function formatStatus(cfg: OpenClawConfig): string {
  const pluginConfig = resolveMemoryCorePluginConfig(cfg);
  const dreaming = resolveMemoryDreamingConfig({
    pluginConfig,
    cfg,
  });
  const deep = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  const timezone = dreaming.timezone ? ` (${dreaming.timezone})` : "";

  return [
    "Dreaming status:",
    `- enabled: ${formatEnabled(dreaming.enabled)}${timezone}`,
    `- sweep cadence: ${dreaming.frequency}`,
    `- promotion policy: score>=${deep.minScore}, recalls>=${deep.minRecallCount}, uniqueQueries>=${deep.minUniqueQueries}`,
  ].join("\n");
}

function formatUsage(includeStatus: string): string {
  return [
    "Usage: /dreaming status",
    "Usage: /dreaming on|off",
    "",
    includeStatus,
    "",
    "Phases:",
    formatPhaseGuide(),
  ].join("\n");
}

function requiresAdminToMutateDreaming(gatewayClientScopes?: readonly string[]): boolean {
  return Array.isArray(gatewayClientScopes) && !gatewayClientScopes.includes("operator.admin");
}

export async function handleDreamingCommand(api: OpenClawPluginApi, ctx: PluginCommandContext) {
  const args = ctx.args?.trim() ?? "";
  const [firstToken = ""] = args
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => normalizeLowercaseStringOrEmpty(token));
  const currentConfig = api.runtime.config.current() as OpenClawConfig;

  if (!firstToken || firstToken === "help" || firstToken === "options" || firstToken === "phases") {
    return { text: formatUsage(formatStatus(currentConfig)) };
  }

  if (firstToken === "status") {
    return { text: formatStatus(currentConfig) };
  }

  if (firstToken === "on" || firstToken === "off") {
    if (requiresAdminToMutateDreaming(ctx.gatewayClientScopes)) {
      return { text: "⚠️ /dreaming on|off requires operator.admin for gateway clients." };
    }
    const enabled = firstToken === "on";
    const nextConfig = updateDreamingEnabledInConfig(currentConfig, enabled);
    await api.runtime.config.replaceConfigFile({
      nextConfig,
      afterWrite: { mode: "auto" },
    });
    return {
      text: [`Dreaming ${enabled ? "enabled" : "disabled"}.`, "", formatStatus(nextConfig)].join(
        "\n",
      ),
    };
  }

  return { text: formatUsage(formatStatus(currentConfig)) };
}

export function registerDreamingCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "dreaming",
    description: "Enable or disable memory dreaming.",
    acceptsArgs: true,
    handler: async (ctx) => await handleDreamingCommand(api, ctx),
  });
}
