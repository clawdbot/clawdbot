// Core doctor compatibility migration pipeline for current config objects.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { migrateLegacySecretRefEnvMarkers } from "../../../secrets/legacy-secretref-env-marker.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import type { LegacyCodexModelIdentity } from "./codex-route-model-ref.js";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";
import { normalizeBaseCompatibilityConfigValues } from "./legacy-config-compatibility-base.js";
import { normalizeLegacyOpenAICodexModelsAddMetadata } from "./legacy-config-core-normalizers.js";
import { stripRetiredTuningKnobs } from "./legacy-config-migrations.runtime.retired-media.js";

function repairNullAgentWorkspaces(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const agents = cfg.agents?.list;
  if (!Array.isArray(agents)) {
    return cfg;
  }

  let repaired = 0;
  const nextAgents = agents.map((agent) => {
    if (
      agent &&
      typeof agent === "object" &&
      (agent as Record<string, unknown>).workspace === null
    ) {
      repaired += 1;
      const { workspace: _workspace, ...rest } = agent as Record<string, unknown>;
      return rest;
    }
    return agent;
  });

  if (repaired === 0) {
    return cfg;
  }

  changes.push(
    `Removed null workspace value${repaired === 1 ? "" : "s"} from agents.list entr${
      repaired === 1 ? "y" : "ies"
    }.`,
  );
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: nextAgents as typeof agents,
    },
  };
}

/** Normalize current config through core, plugin setup, channel, and secret-ref migrations. */
export function normalizeCompatibilityConfigValues(
  cfg: OpenClawConfig,
  options: {
    blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  } = {},
): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next = normalizeBaseCompatibilityConfigValues(
    cfg,
    changes,
    (config) => {
      const setupMigration = runPluginSetupConfigMigrations({
        config,
      });
      if (setupMigration.changes.length === 0) {
        return config;
      }
      changes.push(...setupMigration.changes);
      return setupMigration.config;
    },
    options.blockedModelIdentities,
  );
  const tuningCandidate = structuredClone(next);
  if (stripRetiredTuningKnobs(tuningCandidate)) {
    next = tuningCandidate;
    changes.push("Removed retired runtime tuning knobs; built-in defaults now apply.");
  }
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
  next = normalizeLegacyOpenAICodexModelsAddMetadata(next, changes);
  next = repairNullAgentWorkspaces(next, changes);
  next = pruneBindingsForMissingAgents(next, changes);

  return { config: next, changes };
}
