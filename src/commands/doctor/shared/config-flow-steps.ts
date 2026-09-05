// Doctor config-flow steps for legacy compatibility and unknown-key cleanup.
import { isDeepStrictEqual } from "node:util";
import { configIncludeOwnsAgentRoster } from "../../../config/agent-roster-provenance.js";
import { restoreEnvVarRefs } from "../../../config/env-preserve.js";
import { resolveConfigIncludes } from "../../../config/includes.js";
import { projectAuthoredAgentRosterForWrite } from "../../../config/io.write-prepare.js";
import { formatConfigIssueLines } from "../../../config/issue-format.js";
import { createMergePatch } from "../../../config/merge-patch.js";
import { resolveIncludeRoots } from "../../../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { protectActiveAuthProfileConfig } from "../../doctor-auth-profile-config.js";
import { stripUnknownConfigKeys } from "../../doctor-config-analysis.js";
import type { DoctorConfigMutationState } from "./config-mutation-state.js";
import {
  classifyOtelGrpcMigrationOwnership,
  containsAuthoredInclude,
} from "./include-migration-ownership.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

/** Apply legacy config migrations and update preview/fix state for doctor config flow. */
export function applyLegacyCompatibilityStep(params: {
  snapshot: ConfigFileSnapshot;
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  issueLines: string[];
  changeLines: string[];
  partiallyValid?: boolean;
  blocksWrite?: boolean;
} {
  if (params.snapshot.legacyIssues.length === 0) {
    return {
      state: params.state,
      issueLines: [],
      changeLines: [],
    };
  }

  const issueLines = formatConfigIssueLines(params.snapshot.legacyIssues, "-");
  const otelOwnership = classifyOtelGrpcMigrationOwnership({
    snapshot: params.snapshot,
    authoredConfig: params.snapshot.parsed,
    resolvedConfig: params.snapshot.sourceConfig,
  });
  if (otelOwnership) {
    const ownership = otelOwnership;
    if (ownership.kind === "manual") {
      const otelPath = "diagnostics.otel.protocol";
      const targets =
        ownership.targetPaths.length > 0
          ? ` Inspect these candidate source files and remove or replace ${otelPath} = "grpc" from every definition: ${ownership.targetPaths.join(", ")}.`
          : ` Remove or replace ${otelPath} = "grpc" in the owning $include directive or included file.`;
      return {
        state: params.state,
        issueLines: [
          ...issueLines,
          `- ${otelPath}: Doctor cannot safely rewrite this $include ownership.${targets} No config files were changed.`,
        ],
        changeLines: [],
        blocksWrite: true,
      };
    }
  }
  const hasAuthoredIncludes = containsAuthoredInclude(params.snapshot.parsed);
  // State repairs must inspect resolved paths, not literal env templates.
  const {
    config: migrated,
    sourceConfig: migratedSource,
    changes,
    partiallyValid,
  } = migrateLegacyConfig(params.snapshot.sourceConfig, {
    authoredRaw: params.snapshot.parsed,
    resolvedRaw: params.snapshot.sourceConfig,
  });
  const migrationCandidate = hasAuthoredIncludes && migratedSource ? migratedSource : migrated;
  // Read-time normalization still needs persistence; unresolved advice alone does not.
  const hasLegacyChanges =
    changes.length > 0 ||
    !isDeepStrictEqual(
      params.snapshot.sourceConfigBeforeMigrations ??
        (hasAuthoredIncludes ? params.snapshot.sourceConfig : params.snapshot.parsed),
      params.snapshot.sourceConfig,
    );

  return {
    state: {
      // Keep migrated previews in memory; confirmation controls persistence.
      // Safe partial repairs still commit when unrelated validation issues remain.
      ...params.state,
      ...(migrationCandidate ? { cfg: migrationCandidate, candidate: migrationCandidate } : {}),
      pendingChanges: params.state.pendingChanges || hasLegacyChanges,
      fixHints:
        params.shouldRepair || !hasLegacyChanges
          ? params.state.fixHints
          : [
              ...params.state.fixHints,
              `Run "${params.doctorFixCommand}" to ${partiallyValid ? "finish fixing" : "migrate"} legacy config keys.`,
            ],
    },
    issueLines,
    changeLines: changes,
    partiallyValid: partiallyValid === true ? true : undefined,
  };
}

/** Strip unknown config keys while preserving active auth profile settings. */
export function applyUnknownConfigKeyStep(params: {
  state: DoctorConfigMutationState;
  shouldRepair: boolean;
  doctorFixCommand: string;
}): {
  state: DoctorConfigMutationState;
  removed: string[];
  repairs: string[];
  warnings: string[];
} {
  const unknown = stripUnknownConfigKeys(params.state.candidate);
  if (unknown.removed.length === 0) {
    return { state: params.state, removed: [], repairs: [], warnings: [] };
  }
  const protectedAuth = protectActiveAuthProfileConfig({
    before: params.state.candidate,
    after: unknown.config,
  });

  return {
    state: {
      cfg: params.shouldRepair ? protectedAuth.config : params.state.cfg,
      candidate: protectedAuth.config,
      pendingChanges: true,
      fixHints: params.shouldRepair
        ? params.state.fixHints
        : [...params.state.fixHints, `Run "${params.doctorFixCommand}" to remove these keys.`],
    },
    removed: unknown.removed,
    repairs: protectedAuth.repairs,
    warnings: protectedAuth.warnings,
  };
}

/** Restore references moved by Doctor while keeping resolved values for its state repairs. */
export function restoreDoctorConfigEnvRefs(
  candidate: OpenClawConfig,
  snapshot: ConfigFileSnapshot,
  env?: NodeJS.ProcessEnv,
): OpenClawConfig {
  const authored = resolveConfigIncludes(snapshot.parsed, snapshot.path, undefined, {
    allowedRoots: resolveIncludeRoots(env),
  });
  // The roster key must use the resolved identity from this same snapshot, while
  // migrated leaves retain authored references for the canonical writer to match.
  const canonicalAuthored = projectAuthoredAgentRosterForWrite({
    rootAuthoredConfig: authored,
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
  });
  const migrated = applyLegacyDoctorMigrations(canonicalAuthored, {
    authoredRaw: snapshot.parsed,
    resolvedRaw: snapshot.sourceConfig,
  });
  // The root writer preserves unchanged roster refs after checking include ownership.
  // Single-file and include-file writers still need references moved with their roster.
  const referenceBase =
    containsAuthoredInclude(snapshot.parsed) && !configIncludeOwnsAgentRoster(snapshot)
      ? canonicalAuthored
      : authored;
  const referenceTemplate = createMergePatch(referenceBase, migrated.next ?? canonicalAuthored);
  const restored = restoreEnvVarRefs(candidate, referenceTemplate, env);
  // SAFETY: Restoring string leaves preserves the candidate's config structure.
  return restored as OpenClawConfig;
}
