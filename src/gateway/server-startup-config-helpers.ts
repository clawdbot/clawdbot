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
import { formatConfigIssueLines } from "../config/issue-format.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import type { GatewayAuthConfig, GatewayTailscaleConfig } from "../config/types.gateway.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import { resolveGatewayAuth } from "./auth.js";
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
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
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
      ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
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
}): Promise<GatewayStartupConfigSnapshotLoadResult> {
  const measure = params.measure ?? (async (_name, run) => await run());
  const snapshotRead =
    params.initialSnapshotRead ??
    (await measure("config.snapshot.read", () =>
      readConfigFileSnapshotWithPluginMetadata({ measure }),
    ));
  const configSnapshot = snapshotRead.snapshot;
  const pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
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

  const autoEnable = params.minimalTestGateway
    ? { config: configSnapshot.config, changes: [] as string[] }
    : await measure("config.snapshot.auto-enable", () =>
        applyPluginAutoEnable({
          config: configSnapshot.sourceConfig,
          env: process.env,
          ...(pluginMetadataSnapshot?.manifestRegistry
            ? { manifestRegistry: pluginMetadataSnapshot.manifestRegistry }
            : {}),
          discovery: pluginMetadataSnapshot?.discovery,
        }),
      );
  if (autoEnable.changes.length === 0) {
    return {
      snapshot: configSnapshot,
      wroteConfig,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    };
  }

  params.log.info(
    `gateway: auto-enabled plugins for this runtime without writing config:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
  );
  return {
    snapshot: withRuntimeConfig(configSnapshot, autoEnable.config),
    wroteConfig,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
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
    resolveGatewayAuth({
      authConfig: config.gateway?.auth,
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
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
      tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale),
    },
  };
}
