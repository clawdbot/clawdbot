import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { migrateLegacySecretRefEnvMarkers } from "../../../secrets/legacy-secretref-env-marker.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { normalizeBaseCompatibilityConfigValues } from "./legacy-config-compatibility-base.js";
import {
  normalizeLegacyCommandsConfig,
  normalizeLegacyOpenAICodexModelsAddMetadata,
} from "./legacy-config-core-normalizers.js";

function pruneBindingsForMissingAgents(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const agents = cfg.agents?.list;
  const bindings = cfg.bindings;
  if (!Array.isArray(agents) || agents.length === 0 || !Array.isArray(bindings)) {
    return cfg;
  }

  const validAgents = agents.filter((agent): agent is { id: string } => {
    return agent !== null && typeof agent === "object" && typeof agent.id === "string";
  });
  if (validAgents.length !== agents.length) {
    return cfg;
  }

  const agentIds = new Set(validAgents.map((agent) => normalizeAgentId(agent.id)));
  const nextBindings = bindings.filter((binding) => {
    const agentId = binding && typeof binding === "object" ? binding.agentId : undefined;
    return typeof agentId !== "string" || agentIds.has(normalizeAgentId(agentId));
  });
  const removed = bindings.length - nextBindings.length;
  if (removed === 0) {
    return cfg;
  }

  changes.push(
    `Removed ${removed} binding${removed === 1 ? "" : "s"} that referenced missing agents.list ids.`,
  );
  return {
    ...cfg,
    ...(nextBindings.length > 0 ? { bindings: nextBindings } : { bindings: undefined }),
  };
}

export function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next = normalizeBaseCompatibilityConfigValues(cfg, changes, (config) => {
    const setupMigration = runPluginSetupConfigMigrations({
      config,
    });
    if (setupMigration.changes.length === 0) {
      return config;
    }
    changes.push(...setupMigration.changes);
    return setupMigration.config;
  });
  const channelMigrations = applyChannelDoctorCompatibilityMigrations(next);
  if (channelMigrations.changes.length > 0) {
    next = channelMigrations.next;
    changes.push(...channelMigrations.changes);
  }
  const secretRefMarkers = migrateLegacySecretRefEnvMarkers(next);
  if (secretRefMarkers.changes.length > 0) {
    next = secretRefMarkers.config;
    changes.push(...secretRefMarkers.changes);
  }
  next = normalizeLegacyCommandsConfig(next, changes);
  next = normalizeLegacyOpenAICodexModelsAddMetadata(next, changes);
  next = pruneBindingsForMissingAgents(next, changes);

  return { config: next, changes };
}
