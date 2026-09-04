// Core doctor compatibility migration pipeline for current config objects.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAgentRosterProperty } from "../../../agents/agent-scope-config.js";
import { migrateLegacyContextBudgetConfig } from "../../../config/legacy.context-budget.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { HeartbeatSchema } from "../../../config/zod-schema.agent-runtime.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { migrateLegacySecretRefEnvMarkers } from "../../../secrets/legacy-secretref-env-marker.js";
import { migrateLegacyCommandOwners } from "../../doctor-command-owner.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import type { LegacyCodexModelIdentity } from "./codex-route-model-ref.js";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";
import { normalizeBaseCompatibilityConfigValues } from "./legacy-config-compatibility-base.js";
import { normalizeLegacyOpenAICodexModelsAddMetadata } from "./legacy-config-core-normalizers.js";
import { stripRetiredTuningKnobs } from "./legacy-config-migrations.runtime.retired-media.js";
import { migrateReservedMcpServerNames } from "./reserved-mcp-server-name-migrate.js";

function repairAgentRoster(
  cfg: OpenClawConfig,
  repair: (agent: Record<string, unknown>, path: string) => Record<string, unknown>,
): OpenClawConfig {
  // Snapshot/legacy migration normally converts lists first; blocked include migrations
  // can still leave a legacy list in doctor's best-effort candidate.
  const roster = readAgentRosterProperty(cfg);
  const values = roster?.value;
  if (!roster || (!isRecord(values) && !Array.isArray(values))) {
    return cfg;
  }
  if (Array.isArray(values) !== (roster.kind === "list")) {
    return cfg;
  }
  let changed = false;
  const entries = Object.entries(values).map(([key, agent]) => {
    const path = roster.kind === "entries" ? `agents.entries.${key}` : `agents.list[${key}]`;
    const next = isRecord(agent) ? repair(agent, path) : agent;
    changed ||= next !== agent;
    return [key, next] as const;
  });
  return changed
    ? {
        ...cfg,
        agents: {
          ...cfg.agents,
          [roster.kind]:
            roster.kind === "entries"
              ? Object.fromEntries(entries)
              : entries.map(([, agent]) => agent),
        },
      }
    : cfg;
}

function repairInvalidHeartbeatActiveHours(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const repairHeartbeat = (heartbeat: unknown, path: string): unknown => {
    if (!isRecord(heartbeat) || !Object.hasOwn(heartbeat, "activeHours")) {
      return heartbeat;
    }
    const result = HeartbeatSchema.safeParse({ activeHours: heartbeat.activeHours });
    if (result.success) {
      return heartbeat;
    }

    const { activeHours: _activeHours, ...rest } = heartbeat;
    changes.push(
      `Removed invalid ${path}.activeHours; heartbeats will use unrestricted hours until it is reconfigured.`,
    );
    return rest;
  };

  const defaultsHeartbeat = repairHeartbeat(
    cfg.agents?.defaults?.heartbeat,
    "agents.defaults.heartbeat",
  );
  const next = repairAgentRoster(cfg, (agent, path) => {
    const heartbeat = repairHeartbeat(agent.heartbeat, `${path}.heartbeat`);
    return heartbeat === agent.heartbeat ? agent : { ...agent, heartbeat };
  });

  if (defaultsHeartbeat === cfg.agents?.defaults?.heartbeat) {
    return next;
  }
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: { ...next.agents?.defaults, heartbeat: defaultsHeartbeat },
    },
  } as OpenClawConfig;
}

function repairNullAgentWorkspaces(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  let repaired = 0;
  const next = repairAgentRoster(cfg, (agent) => {
    if (agent.workspace === null) {
      repaired += 1;
      const { workspace: _workspace, ...rest } = agent;
      return rest;
    }
    return agent;
  });

  if (repaired === 0) {
    return cfg;
  }

  changes.push(
    `Removed null workspace value${repaired === 1 ? "" : "s"} from agents.${readAgentRosterProperty(cfg)?.kind} entr${
      repaired === 1 ? "y" : "ies"
    }.`,
  );
  return next;
}

/** Normalize current config through core, plugin setup, channel, and secret-ref migrations. */
export function normalizeCompatibilityConfigValues(
  cfg: OpenClawConfig,
  options: {
    blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
    sourceRaw?: unknown;
    sourceConfigBeforeMigrations?: unknown;
  } = {},
): {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
} {
  const changes: string[] = [];
  let contextBudgetConfig = cfg;
  let contextBudgetWarnings: string[];
  if (options.sourceConfigBeforeMigrations === undefined) {
    const migration = migrateLegacyContextBudgetConfig(cfg);
    contextBudgetConfig = migration.config;
    changes.push(...migration.changes.map(({ message }) => message));
    contextBudgetWarnings = migration.warnings.map(({ message }) => message);
  } else {
    const migration = migrateLegacyContextBudgetConfig(options.sourceConfigBeforeMigrations);
    changes.push(...migration.changes.map(({ message }) => message));
    contextBudgetWarnings = migration.warnings.map(({ message }) => message);
  }
  const reservedMcpServerNames = migrateReservedMcpServerNames(
    contextBudgetConfig,
    options.sourceRaw,
  );
  changes.push(...reservedMcpServerNames.changes);
  let next = normalizeBaseCompatibilityConfigValues(
    reservedMcpServerNames.config,
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
  next = repairInvalidHeartbeatActiveHours(next, changes);
  next = repairNullAgentWorkspaces(next, changes);
  next = migrateLegacyCommandOwners(next, changes);
  next = pruneBindingsForMissingAgents(next, changes);

  return {
    config: next,
    changes,
    ...(contextBudgetWarnings.length > 0 ? { warnings: contextBudgetWarnings } : {}),
  };
}
