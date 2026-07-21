import crypto from "node:crypto";
import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { resolveAgentWorkspaceDirForConfigInspection } from "../agents/agent-scope-config.js";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { createConfigValidationMetadataPluginIdScope } from "../plugins/gateway-startup-plugin-ids.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
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
import type { ConfigIoFactoryOptions, NormalizedConfigIoDeps } from "./io.types.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

type ValidationPluginMetadataSnapshotLoader = {
  load: (config: OpenClawConfig) => PluginMetadataSnapshot;
  getSnapshot: () => PluginMetadataSnapshot | undefined;
};

export type ConfigIoContext = {
  deps: NormalizedConfigIoDeps;
  configPath: string;
  options: ConfigIoFactoryOptions;
  observeLoadConfigSnapshot: (snapshot: ConfigFileSnapshot) => ConfigFileSnapshot;
  finalizeLoadedRuntimeConfig: (config: OpenClawConfig) => OpenClawConfig;
  createValidationPluginMetadataSnapshotLoader: (params: {
    effectiveConfigRaw: unknown;
    env: NodeJS.ProcessEnv;
  }) => ValidationPluginMetadataSnapshotLoader;
  resolveRuntimePreflightSourceConfig: (candidate: OpenClawConfig) => OpenClawConfig;
  resolveSuspiciousRecoveryBackupCandidate: (parsed: unknown) => OpenClawConfig | null;
};

export function createConfigIoContext(options: ConfigIoFactoryOptions = {}): ConfigIoContext {
  const deps = normalizeConfigIoDeps(options);
  const configPath = resolveConfigPathForDeps(deps);

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
        expectedKeys: resolveShellEnvExpectedKeys(deps.env),
        logger: deps.logger,
        timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
      });
    }
    const pendingValue = autoOwnerDisplaySecretByPath.get(configPath);
    const { config: resolvedConfig, generatedSecret } = ensureOwnerDisplaySecret(
      cfg,
      () => pendingValue ?? crypto.randomBytes(32).toString("hex"),
    );
    return applyConfigOverrides(
      retainGeneratedOwnerDisplaySecret({
        config: resolvedConfig,
        configPath,
        generatedSecret,
        state: { pendingByPath: autoOwnerDisplaySecretByPath },
      }),
    );
  }

  function createValidationPluginMetadataSnapshotLoader(params: {
    effectiveConfigRaw: unknown;
    env: NodeJS.ProcessEnv;
  }): ValidationPluginMetadataSnapshotLoader {
    let snapshot: PluginMetadataSnapshot | undefined;
    return {
      load: (config) => {
        if (snapshot) {
          return snapshot;
        }
        const metadataConfig = config;
        snapshot = resolvePluginMetadataSnapshot({
          config: metadataConfig,
          workspaceDir: resolveAgentWorkspaceDirForConfigInspection(metadataConfig, params.env),
          env: params.env,
          allowWorkspaceScopedCurrent: true,
          pluginIdScope: createConfigValidationMetadataPluginIdScope({
            config: metadataConfig,
            env: params.env,
          }),
        });
        return snapshot;
      },
      getSnapshot: () => snapshot,
    };
  }

  function resolveRuntimePreflightSourceConfig(candidate: OpenClawConfig): OpenClawConfig {
    const env = { ...deps.env } as NodeJS.ProcessEnv;
    const resolvedIncludes = resolveConfigIncludesForRead(candidate, configPath, { ...deps, env });
    const resolution = resolveConfigForRead(resolvedIncludes, env, deps.lowerPrecedenceEnv);
    return coerceConfig(resolution.resolvedConfigRaw);
  }

  function resolveSuspiciousRecoveryBackupCandidate(parsed: unknown): OpenClawConfig | null {
    try {
      const candidateEnv = cloneEnvWithPlatformSemantics(deps.env);
      const resolved = resolveConfigIncludesForRead(parsed, configPath, {
        ...deps,
        env: candidateEnv,
      });
      const resolution = resolveConfigForRead(resolved, candidateEnv, deps.lowerPrecedenceEnv);
      const effectiveConfigRaw = resolution.resolvedConfigRaw;
      const pluginMetadata = createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw,
        env: candidateEnv,
      });
      const validated = validateConfigObjectWithPlugins(effectiveConfigRaw, {
        env: candidateEnv,
        pluginValidation: options.pluginValidation,
        loadPluginMetadataSnapshot: pluginMetadata.load,
        sourceRaw: parsed,
        preservedLegacyRootKeys: options.preservedLegacyRootKeys,
      });
      return validated.ok ? coerceConfig(effectiveConfigRaw) : null;
    } catch {
      return null;
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
    resolveSuspiciousRecoveryBackupCandidate,
  };
}

export function resolveModelIdNormalizationPolicies(snapshot: PluginMetadataSnapshot | undefined) {
  return snapshot ? collectManifestModelIdNormalizationPolicies(snapshot.plugins) : undefined;
}

export function materializeConfigForLoad(
  _context: ConfigIoContext,
  config: OpenClawConfig,
  _effectiveConfigRaw: unknown,
  pluginMetadata: PluginMetadataSnapshot | undefined,
): OpenClawConfig {
  return materializeRuntimeConfig(config, "load", {
    manifestRegistry: pluginMetadata?.manifestRegistry,
  });
}
