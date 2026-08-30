// Shared validation, auth-surface, and config-load helpers for Gateway startup.
import {
  formatInvalidConfigRecoveryHint,
  formatPluginPackagingRuntimeOutputRecoveryHint,
} from "../cli/config-recovery-hints.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import {
  type ReadConfigFileSnapshotWithPluginMetadataResult,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/io.js";
import { renderConfigValidationIssueLines } from "../config/issue-location.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../config/legacy.default-agent-owner.js";
import { materializeLegacyDefaultAgentRoles } from "../config/legacy.default-agent-roles.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import {
  copyConfigResolutionFacts,
  copyConfigResolutionFactsExcept,
} from "../config/resolution-facts.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginMetadataOwner,
  PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import { assertGatewayAuthNotKnownWeak } from "./known-weak-gateway-secrets.js";
import { mergeGatewayAuthConfig, mergeGatewayTailscaleConfig } from "./startup-auth.js";

export type GatewayStartupLog = {
  info: (message: string) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string) => void;
};

export type GatewayStartupConfigMeasure = <T>(
  name: string,
  run: () => T | Promise<T>,
  options?: { omitErrorMessage?: boolean },
) => Promise<T>;

export type GatewayStartupConfigSnapshotLoadResult = {
  snapshot: ConfigFileSnapshot;
  wroteConfig: boolean;
  pluginMetadata: PreparedPluginMetadata;
};

/** Throw a formatted startup error when the loaded config snapshot is invalid. */
export function assertValidGatewayStartupConfigSnapshot(
  snapshot: ConfigFileSnapshot,
  options: { includeDoctorHint?: boolean } = {},
): void {
  if (snapshot.valid) {
    return;
  }
  const issues =
    snapshot.issues.length > 0
      ? renderConfigValidationIssueLines(snapshot, "").join("\n")
      : "Unknown validation issue.";
  const recoveryHint =
    options.includeDoctorHint && isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
      ? `\n${formatPluginPackagingRuntimeOutputRecoveryHint()}`
      : options.includeDoctorHint
        ? `\n${formatInvalidConfigRecoveryHint()}`
        : "";
  throw createInvalidConfigError(snapshot.path, `${issues}${recoveryHint}`, {
    recovery: isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot) ? "manual" : "doctor",
  });
}

function withRuntimeConfig(
  snapshot: ConfigFileSnapshot,
  runtimeConfig: OpenClawConfig,
): ConfigFileSnapshot {
  copyConfigResolutionFacts(snapshot.sourceConfig, runtimeConfig);
  return {
    ...snapshot,
    runtimeConfig,
    config: runtimeConfig,
  };
}

/** Load and validate the config snapshot, applying runtime-only plugin auto-enable changes. */
export async function loadGatewayStartupConfigSnapshot(params: {
  minimalTestGateway: boolean;
  log: GatewayStartupLog;
  measure?: GatewayStartupConfigMeasure;
  initialSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
  pluginMetadataOwner: PluginMetadataOwner;
}): Promise<GatewayStartupConfigSnapshotLoadResult> {
  const measure = params.measure ?? (async (_name, run) => await run());
  const snapshotRead =
    params.initialSnapshotRead ??
    (await measure("config.snapshot.read", () =>
      readConfigFileSnapshotWithPluginMetadata({
        measure,
        pluginMetadataOwner: params.pluginMetadataOwner,
      }),
    ));
  const configSnapshot = snapshotRead.snapshot;
  const wroteConfig = false;
  if (configSnapshot.legacyIssues.length > 0 && isNixMode) {
    throw createInvalidConfigError(
      configSnapshot.path,
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
      { recovery: "manual" },
    );
  }
  if (configSnapshot.exists) {
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }
  const pluginMetadata = params.pluginMetadataOwner.prepare({
    config: configSnapshot.sourceConfig,
    seed: snapshotRead.pluginMetadata,
  });

  const autoEnable = params.minimalTestGateway
    ? { config: configSnapshot.config, changes: [] as string[] }
    : await measure("config.snapshot.auto-enable", () =>
        applyPluginAutoEnable({
          config: configSnapshot.sourceConfig,
          env: process.env,
          manifestRegistry: pluginMetadata.manifestRegistry,
          discovery: pluginMetadata.selectedSnapshot.discovery,
        }),
      );
  if (autoEnable.changes.length === 0) {
    return {
      snapshot: configSnapshot,
      wroteConfig,
      pluginMetadata,
    };
  }

  params.log.info(
    `gateway: auto-enabled plugins for this runtime without writing config:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
  );
  const legacyDefaultAgentId = tryGetLegacyDefaultAgentId(configSnapshot.sourceConfig);
  const runtimeConfig = legacyDefaultAgentId
    ? materializeLegacyDefaultAgentRoles(autoEnable.config, legacyDefaultAgentId).config
    : autoEnable.config;
  retainLegacyDefaultAgentId(runtimeConfig, legacyDefaultAgentId);
  return {
    snapshot: withRuntimeConfig(configSnapshot, runtimeConfig),
    wroteConfig,
    pluginMetadata,
  };
}

export function hasActiveGatewayAuthSecretRef(config: OpenClawConfig): boolean {
  const states = evaluateGatewayAuthSurfaceStates({
    config,
    defaults: config.secrets?.defaults,
    env: process.env,
  });
  return GATEWAY_AUTH_SURFACE_PATHS.some((path) => {
    const state = states[path];
    return state.hasSecretRef && state.active;
  });
}

export function assertRuntimeGatewayAuthNotKnownWeak(config: OpenClawConfig): void {
  assertGatewayAuthNotKnownWeak(
    resolveGatewayAuthForConfig({
      config,
      env: process.env,
      tailscaleMode: config.gateway?.tailscale?.mode ?? "off",
    }),
  );
}

export function logGatewayAuthSurfaceDiagnostics(
  prepared: {
    sourceConfig: OpenClawConfig;
    warnings: Array<{ code: string; path: string; message: string }>;
  },
  logSecrets: GatewayStartupLog,
): void {
  const states = evaluateGatewayAuthSurfaceStates({
    config: prepared.sourceConfig,
    defaults: prepared.sourceConfig.secrets?.defaults,
    env: process.env,
  });
  const inactiveWarnings = new Map<string, string>();
  for (const warning of prepared.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarnings.set(warning.path, warning.message);
  }
  for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
    const state = states[path];
    if (!state.hasSecretRef) {
      continue;
    }
    const stateLabel = state.active ? "active" : "inactive";
    const inactiveDetails =
      !state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : undefined;
    const details = inactiveDetails ?? state.reason;
    logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
  }
}

export function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: { auth?: GatewayAuthConfig; tailscale?: GatewayTailscaleConfig },
): OpenClawConfig {
  if (!overrides.auth && !overrides.tailscale) {
    return config;
  }
  const next = {
    ...config,
    gateway: {
      ...config.gateway,
      auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
      tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale),
    },
  };
  copyConfigResolutionFactsExcept(config, next, [
    ...(overrides.auth?.token !== undefined ? ["gateway.auth.token"] : []),
    ...(overrides.auth?.password !== undefined ? ["gateway.auth.password"] : []),
  ]);
  return next;
}
