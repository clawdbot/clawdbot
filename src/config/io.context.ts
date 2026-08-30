import crypto from "node:crypto";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { classifyOtelGrpcMigrationOwnership } from "../commands/doctor/shared/include-migration-ownership.js";
import { applyLegacyDoctorMigrations } from "../commands/doctor/shared/legacy-config-compat.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  createPluginMetadataOwner,
  getOrCreatePluginMetadataOwner,
  getScopedPluginMetadata,
  type PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { applyConfigEnvVars, cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { retainGeneratedOwnerDisplaySecret } from "./io.owner-display-secret.js";
import {
  coerceConfig,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "./io.read-helpers.js";
import { autoOwnerDisplaySecretByPath } from "./io.state.js";
import type {
  ConfigIoFactoryOptions,
  ConfigRecoveryCandidate,
  ConfigRecoveryCandidatePreparation,
  NormalizedConfigIoDeps,
} from "./io.types.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import { migrateLegacyContextBudgetConfig } from "./legacy.context-budget.js";
import { inheritLegacyDefaultAgentId } from "./legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { copyConfigResolutionFacts } from "./resolution-facts.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type ValidationPluginMetadataSnapshotLoader = {
  load: (config: OpenClawConfig) => Pick<PluginMetadataSnapshot, "manifestRegistry">;
  getManifestRegistry: () => PluginManifestRegistry | undefined;
  getMetadata: () => PreparedPluginMetadata | undefined;
};

export type ConfigIoContext = {
  deps: NormalizedConfigIoDeps;
  configPath: string;
  options: ConfigIoFactoryOptions;
  observeLoadConfigSnapshot: (snapshot: ConfigFileSnapshot) => ConfigFileSnapshot;
  finalizeLoadedRuntimeConfig: (config: OpenClawConfig) => OpenClawConfig;
  createValidationPluginMetadataSnapshotLoader: (params: {
    env: NodeJS.ProcessEnv;
    allowCurrentPluginMetadata?: boolean;
  }) => ValidationPluginMetadataSnapshotLoader;
  resolveRuntimePreflightSourceConfig: (candidate: OpenClawConfig) => OpenClawConfig;
  prepareRecoveryBackupCandidate: (
    candidate: ConfigRecoveryCandidate,
  ) => ConfigRecoveryCandidatePreparation;
};

export function createConfigIoContext(options: ConfigIoFactoryOptions = {}): ConfigIoContext {
  const deps = normalizeConfigIoDeps(options);
  const configPath = resolveConfigPathForDeps(deps);
  const scopedMetadata = getScopedPluginMetadata(deps.env);
  const metadataOwner =
    options.pluginMetadataOwner ??
    (scopedMetadata ? createPluginMetadataOwner() : getOrCreatePluginMetadataOwner());

  function observeLoadConfigSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
    if (deps.observe) {
      observeConfigSnapshotSync(deps, snapshot);
    }
    return snapshot;
  }

  function finalizeLoadedRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
    const duplicates = findDuplicateAgentDirs(cfg, { env: deps.env, homedir: deps.homedir });
    if (duplicates.length > 0) {
      throw new DuplicateAgentDirError(duplicates);
    }
    applyConfigEnvVars(cfg, deps.env);
    const enabled = shouldEnableShellEnvFallback(deps.env) || cfg.env?.shellEnv?.enabled === true;
    if (enabled && options.shellEnvFallback !== "defer" && !shouldDeferShellEnvFallback(deps.env)) {
      loadShellEnvFallback({
        enabled: true,
        env: deps.env,
        expectedKeys: resolveShellEnvExpectedKeys(deps.env, cfg),
        logger: deps.logger,
        timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
      });
    }
    const pendingValue = autoOwnerDisplaySecretByPath.get(configPath);
    const { config: resolvedConfig, generatedSecret } = ensureOwnerDisplaySecret(
      cfg,
      () => pendingValue ?? crypto.randomBytes(32).toString("hex"),
    );
    const finalized = applyConfigOverrides(
      retainGeneratedOwnerDisplaySecret({
        config: resolvedConfig,
        configPath,
        generatedSecret,
        state: { pendingByPath: autoOwnerDisplaySecretByPath },
      }),
    );
    const inherited = inheritLegacyDefaultAgentId(cfg, finalized);
    copyConfigResolutionFacts(cfg, inherited);
    return inherited;
  }

  function createValidationPluginMetadataSnapshotLoader(params: {
    env: NodeJS.ProcessEnv;
    allowCurrentPluginMetadata?: boolean;
  }): ValidationPluginMetadataSnapshotLoader {
    let metadata: PreparedPluginMetadata | undefined;
    return {
      load: (config) => {
        metadata ??= metadataOwner.prepare({
          config,
          env: params.env,
          allowCurrent: params.allowCurrentPluginMetadata,
          seed: scopedMetadata,
        });
        return { manifestRegistry: metadata.manifestRegistry };
      },
      getManifestRegistry: () => metadata?.manifestRegistry,
      getMetadata: () => metadata,
    };
  }

  function resolveRuntimePreflightSourceConfig(candidate: OpenClawConfig): OpenClawConfig {
    const env = { ...deps.env } as NodeJS.ProcessEnv;
    const resolvedIncludes = resolveConfigIncludesForRead(candidate, configPath, { ...deps, env });
    const resolution = resolveConfigForRead(resolvedIncludes, env, deps.lowerPrecedenceEnv);
    const contextBudgetConfig = migrateLegacyContextBudgetConfig(
      resolution.resolvedConfigRaw,
    ).config;
    return coerceConfig(migratePersistedImplicitMainRoster(contextBudgetConfig).config);
  }

  function prepareRecoveryBackupCandidate(
    candidate: ConfigRecoveryCandidate,
  ): ConfigRecoveryCandidatePreparation {
    try {
      const originalEnv = cloneEnvWithPlatformSemantics(deps.env);
      const includeProvenance: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number][] = [];
      const originalResolvedIncludes = resolveConfigIncludesForRead(
        candidate.parsed,
        configPath,
        { ...deps, env: originalEnv },
        undefined,
        undefined,
        undefined,
        (event) => {
          const { value: _value, ...ownership } = event;
          includeProvenance.push(ownership);
        },
      );
      const originalResolution = resolveConfigForRead(
        originalResolvedIncludes,
        originalEnv,
        deps.lowerPrecedenceEnv,
      );
      const otelOwnership = classifyOtelGrpcMigrationOwnership({
        snapshot: { path: configPath, includeProvenance },
        authoredConfig: candidate.parsed,
        resolvedConfig: originalResolution.resolvedConfigRaw,
      });
      if (otelOwnership && otelOwnership.kind !== "direct") {
        return {
          ok: false,
          reason:
            otelOwnership.kind === "resolved-only"
              ? "candidate migration cannot persist an env-resolved diagnostics.otel.protocol repair"
              : "candidate migration requires an include-owned diagnostics.otel.protocol repair",
        };
      }
      // Recovery is a migration boundary, not runtime compatibility: the canonical Doctor
      // registry owns historical shapes before current-schema validation and any disk write.
      const migrated = applyLegacyDoctorMigrations(candidate.parsed, {
        authoredRaw: candidate.parsed,
        resolvedRaw: originalResolution.resolvedConfigRaw,
      });
      const authoredCandidate = migrated.next ?? candidate.parsed;
      const candidateEnv = cloneEnvWithPlatformSemantics(deps.env);
      const resolved = resolveConfigIncludesForRead(authoredCandidate, configPath, {
        ...deps,
        env: candidateEnv,
      });
      const resolution = resolveConfigForRead(resolved, candidateEnv, deps.lowerPrecedenceEnv);
      const effectiveConfigRaw = resolution.resolvedConfigRaw;
      const pluginMetadata = createValidationPluginMetadataSnapshotLoader({
        env: candidateEnv,
      });
      const validated = validateConfigObjectWithPlugins(effectiveConfigRaw, {
        env: candidateEnv,
        pluginValidation: options.pluginValidation,
        loadPluginMetadataSnapshot: pluginMetadata.load,
        sourceRaw: authoredCandidate,
        preservedLegacyRootKeys: options.preservedLegacyRootKeys,
      });
      if (!validated.ok) {
        const issueSummary = formatConfigIssueSummary(validated.issues.slice(0, 3)) ?? "";
        const detail = issueSummary.length > 800 ? `${issueSummary.slice(0, 799)}…` : issueSummary;
        return {
          ok: false,
          reason: `candidate remains invalid after legacy migration${detail ? `: ${detail}` : ""}`,
        };
      }
      return {
        ok: true,
        candidate: {
          config: validated.config,
          parsed: authoredCandidate,
          raw: migrated.next
            ? JSON.stringify(authoredCandidate, null, 2).trimEnd().concat("\n")
            : candidate.raw,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `candidate preparation failed: ${detail}` };
    }
  }

  return {
    deps,
    configPath,
    options,
    observeLoadConfigSnapshot,
    finalizeLoadedRuntimeConfig,
    createValidationPluginMetadataSnapshotLoader,
    resolveRuntimePreflightSourceConfig,
    prepareRecoveryBackupCandidate,
  };
}

export function resolveModelIdNormalizationPolicies(
  snapshot: Pick<PluginMetadataSnapshot, "plugins"> | undefined,
) {
  return snapshot ? collectManifestModelIdNormalizationPolicies(snapshot.plugins) : undefined;
}
