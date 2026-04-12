import { formatCliCommand } from "../cli/command-format.js";
import {
  type ConfigFileSnapshot,
  type GatewayAuthConfig,
  type GatewayTailscaleConfig,
  type OpenClawConfig,
  applyConfigOverrides,
  isNixMode,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  GATEWAY_AUTH_SURFACE_PATHS,
  evaluateGatewayAuthSurfaceStates,
} from "../secrets/runtime-gateway-auth-surfaces.js";
import {
  activateSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  ensureGatewayStartupAuth,
  mergeGatewayAuthConfig,
  mergeGatewayTailscaleConfig,
} from "./startup-auth.js";

type GatewayStartupLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

type GatewaySecretsStateEventCode = "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED";

export type ActivateRuntimeSecrets = (
  config: OpenClawConfig,
  params: { reason: "startup" | "reload" | "restart-check"; activate: boolean },
) => Promise<Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>>;

type PrepareRuntimeSecretsSnapshot = typeof prepareSecretsRuntimeSnapshot;
type ActivateRuntimeSecretsSnapshot = typeof activateSecretsRuntimeSnapshot;

type GatewayStartupConfigOverrides = {
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
};

export async function loadGatewayStartupConfigSnapshot(params: {
  minimalTestGateway: boolean;
  log: GatewayStartupLog;
}): Promise<ConfigFileSnapshot> {
  let configSnapshot = await readConfigFileSnapshot();
  if (configSnapshot.legacyIssues.length > 0 && isNixMode) {
    throw new Error(
      "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.",
    );
  }
  if (configSnapshot.exists) {
    assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
  }

  const autoEnable = params.minimalTestGateway
    ? { config: configSnapshot.config, changes: [] as string[] }
    : applyPluginAutoEnable({ config: configSnapshot.config, env: process.env });
  if (autoEnable.changes.length === 0) {
    return configSnapshot;
  }

  try {
    await writeConfigFile(autoEnable.config);
    configSnapshot = await readConfigFileSnapshot();
    assertValidGatewayStartupConfigSnapshot(configSnapshot);
    params.log.info(
      `gateway: auto-enabled plugins:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  } catch (err) {
    params.log.warn(`gateway: failed to persist plugin auto-enable changes: ${String(err)}`);
  }

  return configSnapshot;
}

export function createRuntimeSecretsActivator(params: {
  logSecrets: GatewayStartupLog;
  emitStateEvent: (
    code: GatewaySecretsStateEventCode,
    message: string,
    cfg: OpenClawConfig,
  ) => void;
  prepareRuntimeSecretsSnapshot?: PrepareRuntimeSecretsSnapshot;
  activateRuntimeSecretsSnapshot?: ActivateRuntimeSecretsSnapshot;
}): ActivateRuntimeSecrets {
  let secretsDegraded = false;
  let secretsActivationTail: Promise<void> = Promise.resolve();
  const prepareRuntimeSecretsSnapshot =
    params.prepareRuntimeSecretsSnapshot ?? prepareSecretsRuntimeSnapshot;
  const activateRuntimeSecretsSnapshot =
    params.activateRuntimeSecretsSnapshot ?? activateSecretsRuntimeSnapshot;

  const runWithSecretsActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = secretsActivationTail.then(operation, operation);
    secretsActivationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };

  return async (config, activationParams) =>
    await runWithSecretsActivationLock(async () => {
      try {
        const prepared = await prepareRuntimeSecretsSnapshot({
          config: pruneSkippedStartupSecretSurfaces(config),
        });
        if (activationParams.activate) {
          activateRuntimeSecretsSnapshot(prepared);
          logGatewayAuthSurfaceDiagnostics(prepared, params.logSecrets);
        }
        for (const warning of prepared.warnings) {
          params.logSecrets.warn(`[${warning.code}] ${warning.message}`);
        }
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          params.logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          params.emitStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        if (!secretsDegraded) {
          params.logSecrets.error?.(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          if (activationParams.reason !== "startup") {
            params.emitStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          params.logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        secretsDegraded = true;
        if (activationParams.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        throw err;
      }
    });
}

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
  const doctorHint = options.includeDoctorHint
    ? `\nRun "${formatCliCommand("openclaw doctor --fix")}" to repair, then retry.`
    : "";
  throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}

export async function prepareGatewayStartupConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  authOverride?: GatewayAuthConfig;
  tailscaleOverride?: GatewayTailscaleConfig;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
}): Promise<Awaited<ReturnType<typeof ensureGatewayStartupAuth>>> {
  assertValidGatewayStartupConfigSnapshot(params.configSnapshot);

  const runtimeConfig = applyConfigOverrides(params.configSnapshot.config);
  const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(runtimeConfig, {
    auth: params.authOverride,
    tailscale: params.tailscaleOverride,
  });
  const preflightConfig = (
    await params.activateRuntimeSecrets(startupPreflightConfig, {
      reason: "startup",
      activate: false,
    })
  ).config;
  const preflightAuthOverride =
    typeof preflightConfig.gateway?.auth?.token === "string" ||
    typeof preflightConfig.gateway?.auth?.password === "string"
      ? {
          ...params.authOverride,
          ...(typeof preflightConfig.gateway?.auth?.token === "string"
            ? { token: preflightConfig.gateway.auth.token }
            : {}),
          ...(typeof preflightConfig.gateway?.auth?.password === "string"
            ? { password: preflightConfig.gateway.auth.password }
            : {}),
        }
      : params.authOverride;

  const authBootstrap = await ensureGatewayStartupAuth({
    cfg: runtimeConfig,
    env: process.env,
    authOverride: preflightAuthOverride,
    tailscaleOverride: params.tailscaleOverride,
    persist: true,
    baseHash: params.configSnapshot.hash,
  });
  const runtimeStartupConfig = applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
    auth: params.authOverride,
    tailscale: params.tailscaleOverride,
  });
  const activatedConfig = (
    await params.activateRuntimeSecrets(runtimeStartupConfig, {
      reason: "startup",
      activate: true,
    })
  ).config;
  return {
    ...authBootstrap,
    cfg: activatedConfig,
  };
}

function pruneSkippedStartupSecretSurfaces(config: OpenClawConfig): OpenClawConfig {
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  if (!skipChannels || !config.channels) {
    return config;
  }
  return {
    ...config,
    channels: undefined,
  };
}

function logGatewayAuthSurfaceDiagnostics(
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

function applyGatewayAuthOverridesForStartupPreflight(
  config: OpenClawConfig,
  overrides: GatewayStartupConfigOverrides,
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
