import {
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  mergeMigrationConfigValue,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  asNonArrayRecord,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseYaml } from "yaml";
import { importsMcpSensitiveValues, mapMcpServer, mcpManualItems } from "./config-mcp.js";
import { providerConfig } from "./config-provider-contract.js";
import {
  addSelectedModelToProvider,
  collectHermesProviders,
  providerManualItems,
} from "./config-providers.js";
import { childRecord, readStringArray, sanitizeName } from "./helpers.js";

function mapSkillEntries(config: Record<string, unknown>): Record<string, unknown> {
  const skills = childRecord(config, "skills");
  const entries = new Map<string, { config?: Record<string, unknown>; enabled?: false }>();
  for (const [skillKey, value] of Object.entries(childRecord(skills, "config"))) {
    if (isRecord(value)) {
      entries.set(skillKey, { config: value });
    }
  }
  let disabled = skills.disabled;
  // Hermes config commands also persist JSON/Python array strings. YAML accepts
  // both list forms without evaluating source code; malformed strings stay names.
  if (typeof disabled === "string" && disabled.trimStart().startsWith("[")) {
    try {
      disabled = parseYaml(disabled);
    } catch {
      // Hermes treats a malformed list string as a single skill name.
    }
  }
  for (const value of readStringArray(Array.isArray(disabled) ? disabled : [disabled])) {
    const skillKey = value.trim();
    // Hermes always keeps its operating manual active, even in skills.disabled.
    if (skillKey !== "hermes-agent") {
      entries.set(skillKey, { ...entries.get(skillKey), enabled: false });
    }
  }
  // Apply the shared untrusted-key policy before skill names become path segments.
  return asNonArrayRecord(mergeMigrationConfigValue({}, Object.fromEntries(entries)));
}

export function buildConfigItems(params: {
  ctx: MigrationProviderContext;
  config: Record<string, unknown>;
  env?: Record<string, string>;
  runtimeEnv?: Record<string, string>;
  modelRef?: string;
  hasMemoryFiles?: boolean;
}): MigrationItem[] {
  const items: MigrationItem[] = [];
  const addConfigPatch = (patch: Parameters<typeof createMigrationConfigPatchItem>[0]) => {
    items.push(
      createMigrationConfigPatchItem({
        ...patch,
        conflict:
          !params.ctx.overwrite &&
          hasMigrationConfigPatchConflict(params.ctx.config, patch.path, patch.value),
      }),
    );
  };
  const memory = childRecord(params.config, "memory");
  const memoryProvider = normalizeOptionalString(memory.provider);

  if (params.hasMemoryFiles || memoryProvider) {
    addConfigPatch({
      id: "config:memory-plugin-slot",
      target: "plugins.slots",
      path: ["plugins", "slots"],
      value: { memory: "memory-core" },
      message: "Select the default OpenClaw memory plugin for imported file memory.",
    });
  }

  if (memoryProvider === "honcho") {
    const value = {
      honcho: {
        enabled: true,
        config: childRecord(memory, "honcho"),
      },
    };
    addConfigPatch({
      id: "config:memory-plugin:honcho",
      target: "plugins.entries.honcho",
      path: ["plugins", "entries"],
      value,
      message: "Preserve Hermes Honcho memory settings as a plugin entry for manual activation.",
    });
    items.push(
      createMigrationManualItem({
        id: "manual:memory-provider:honcho",
        source: "config.yaml:memory.provider",
        message:
          "Hermes used Honcho memory. OpenClaw keeps built-in memory selected until the matching plugin is installed and reviewed.",
        recommendation:
          "Install or review the Honcho memory plugin before selecting it for plugins.slots.memory.",
      }),
    );
  } else if (memoryProvider && !["builtin", "file", "files"].includes(memoryProvider)) {
    items.push(
      createMigrationManualItem({
        id: `manual:memory-provider:${memoryProvider}`,
        source: "config.yaml:memory.provider",
        message: `Hermes memory provider "${memoryProvider}" does not have a known OpenClaw mapping.`,
        recommendation: "Install or configure an equivalent OpenClaw memory plugin manually.",
      }),
    );
  }

  const providers = collectHermesProviders(
    params.config,
    params.env,
    Boolean(params.ctx.includeSecrets),
  );
  addSelectedModelToProvider(providers, params.modelRef);
  for (const provider of providers) {
    const value = { [provider.id]: providerConfig(provider) };
    addConfigPatch({
      id: `config:model-provider:${sanitizeName(provider.id)}`,
      target: `models.providers.${provider.id}`,
      path: ["models", "providers"],
      value,
      message: `Import Hermes provider and custom endpoint config for "${provider.id}".`,
      sensitive: provider.sensitive,
    });
  }
  items.push(
    ...providerManualItems(params.config, params.env ?? {}, Boolean(params.ctx.includeSecrets)),
  );

  const mcpConfig = params.config.mcp;
  const rawMcpServers =
    params.config.mcp_servers ??
    (isRecord(mcpConfig) && isRecord(mcpConfig.servers) ? mcpConfig.servers : mcpConfig);
  const rawMcpSource =
    params.config.mcp_servers !== undefined
      ? "config.yaml:mcp_servers"
      : isRecord(mcpConfig) && isRecord(mcpConfig.servers)
        ? "config.yaml:mcp.servers"
        : "config.yaml:mcp";
  if (isRecord(rawMcpServers)) {
    // Hermes loads process env first, then lets its source .env override those values.
    const mcpEnv = { ...params.runtimeEnv, ...params.env };
    for (const [name, rawServer] of Object.entries(rawMcpServers)) {
      if (!isRecord(rawServer)) {
        continue;
      }
      const server = mapMcpServer(rawServer, Boolean(params.ctx.includeSecrets), mcpEnv);
      if (Object.keys(server).length > 0) {
        const value = { [name]: server };
        addConfigPatch({
          id: `config:mcp-server:${sanitizeName(name)}`,
          target: `mcp.servers.${name}`,
          path: ["mcp", "servers"],
          value,
          message: `Import Hermes MCP server definition "${name}".`,
          sensitive: importsMcpSensitiveValues(rawServer, Boolean(params.ctx.includeSecrets)),
        });
      }
      items.push(
        ...mcpManualItems({
          name,
          raw: rawServer,
          includeSecrets: Boolean(params.ctx.includeSecrets),
          env: mcpEnv,
          source: `${rawMcpSource}.${name}`,
        }),
      );
    }
  }

  for (const [skillKey, value] of Object.entries(mapSkillEntries(params.config))) {
    const configPath = ["skills", "entries", skillKey];
    addConfigPatch({
      id: `config:skill-entry:${sanitizeName(skillKey)}`,
      target: configPath.join("."),
      path: configPath,
      value,
      message: "Import Hermes skill config values and global disabled state.",
    });
  }

  return items;
}
