/** Collects gateway health while deferring heavy text presentation until success. */
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { withProgress } from "../cli/progress.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildGatewayProbeConnectionDetails,
  callGateway,
  formatGatewayAuthErrorJson,
  formatGatewayClientRequestErrorJson,
  formatGatewayTransportErrorJson,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import type { HealthSummary } from "../gateway/health/types.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  buildCredentialsRequiredHealthDiagnostic,
  buildRateLimitedHealthDiagnostic,
  gatewayConnectErrorWasRateLimited,
  GATEWAY_HEALTH_REACHABLE_LINE,
  gatewayProbeResultSawGateway,
  gatewayProbeResultWasRateLimited,
} from "./gateway-health-auth-diagnostic.js";

export {
  formatConfigReloadHealthLine,
  formatContextEngineHealthLine,
  formatDeliveryQueueHealthLine,
  formatHealthChannelLines,
} from "./health-format.js";
export type { HealthSummary } from "../gateway/health/types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const loadConfigRuntime = async () => await import("../config/config.js");

function isGatewayHealthAuthUnavailableError(error: unknown): boolean {
  return isGatewayCredentialsRequiredError(error) || isGatewaySecretRefUnavailableError(error);
}

export async function emitReachableGatewayAuthDiagnostic(params: {
  error: unknown;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  token?: string;
  password?: string;
  ignoreEnvUrlOverride?: boolean;
  localPortOverride?: number;
  json?: boolean;
}): Promise<boolean> {
  const directRateLimit = gatewayConnectErrorWasRateLimited(params.error);
  if (!directRateLimit && !isGatewayHealthAuthUnavailableError(params.error)) {
    return false;
  }
  if (directRateLimit) {
    const diagnostic = buildRateLimitedHealthDiagnostic(params.error);
    if (params.json) {
      writeRuntimeJson(params.runtime, diagnostic);
    } else {
      params.runtime.log(GATEWAY_HEALTH_REACHABLE_LINE);
      params.runtime.log(diagnostic.error.message);
    }
    params.runtime.exit(1);
    return true;
  }
  const details = await buildGatewayProbeConnectionDetails({
    config: params.config,
    token: params.token,
    password: params.password,
    ignoreEnvUrlOverride: params.ignoreEnvUrlOverride,
    localPortOverride: params.localPortOverride,
  });
  const probe = await probeGatewayStatus({
    url: details.url,
    token: params.token,
    password: params.password,
    tlsFingerprint: details.tlsFingerprint,
    preauthHandshakeTimeoutMs: details.preauthHandshakeTimeoutMs,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    config: params.config,
    json: params.json,
  });
  if (!gatewayProbeResultSawGateway(probe)) {
    return false;
  }
  const diagnostic = gatewayProbeResultWasRateLimited(probe)
    ? buildRateLimitedHealthDiagnostic()
    : buildCredentialsRequiredHealthDiagnostic();
  if (params.json) {
    writeRuntimeJson(params.runtime, diagnostic);
  } else {
    params.runtime.log(GATEWAY_HEALTH_REACHABLE_LINE);
    params.runtime.log(diagnostic.error.message);
  }
  params.runtime.exit(1);
  return true;
}

/** Runs the `openclaw health` command against the gateway and renders JSON or text. */
export async function healthCommand(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    config?: OpenClawConfig;
    token?: string;
    password?: string;
    ignoreEnvUrlOverride?: boolean;
    localPortOverride?: number;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  const config = opts.config ?? (await readNonObservingHealthConfig());
  let summary: HealthSummary;
  try {
    summary = await withProgress(
      {
        label: "Checking gateway health…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway<HealthSummary>({
          method: "health",
          params: opts.verbose ? { probe: true } : undefined,
          timeoutMs: opts.timeoutMs,
          config,
          token: opts.token,
          password: opts.password,
          sharedStateMode: "read-only",
          ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
          localPortOverride: opts.localPortOverride,
        }),
    );
  } catch (error) {
    if (
      await emitReachableGatewayAuthDiagnostic({
        error,
        config,
        runtime,
        timeoutMs: opts.timeoutMs,
        token: opts.token,
        password: opts.password,
        ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
        localPortOverride: opts.localPortOverride,
        json: opts.json,
      })
    ) {
      return;
    }
    if (opts.json) {
      const payload =
        formatGatewayAuthErrorJson(error) ??
        formatGatewayClientRequestErrorJson(error) ??
        formatGatewayTransportErrorJson(error);
      if (payload) {
        writeRuntimeJson(runtime, payload);
        runtime.exit(1);
        return;
      }
    }
    throw error;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, summary);
    return;
  }
  const { renderHealthText } = await import("./health-text.js");
  await renderHealthText({
    config,
    summary,
    runtime,
    verbose: opts.verbose,
    ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
    localPortOverride: opts.localPortOverride,
  });
}

export async function readNonObservingHealthConfig(): Promise<OpenClawConfig> {
  const { readConfigFileSnapshot } = await loadConfigRuntime();
  const snapshot = await readConfigFileSnapshot({
    observe: false,
    pluginValidation: "core-only",
  });
  return snapshot.runtimeConfig ?? snapshot.config;
}
