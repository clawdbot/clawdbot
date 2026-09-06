import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import { sleep } from "../../utils.js";
import {
  inspectGatewayPortHealth,
  resolveGatewayRestartProbeContext,
} from "./restart-health-probe.js";
import {
  DEFAULT_RESTART_HEALTH_ATTEMPTS,
  DEFAULT_RESTART_HEALTH_DELAY_MS,
} from "./restart-health.constants.js";
import type { GatewayPortHealthSnapshot } from "./restart-health.types.js";
import { waitForGatewayLockReplacement } from "./restart-lock-replacement.js";

export async function waitForGatewayHealthyListener(params: {
  port: number;
  attempts?: number;
  delayMs?: number;
  includePluginHealth?: boolean;
  previousLockIdentity?: GatewayLockIdentity;
  waitIndefinitelyForPreviousOwner?: boolean;
}): Promise<GatewayPortHealthSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
  const previousLockIdentity = params.previousLockIdentity;

  const probeContext = await resolveGatewayRestartProbeContext(undefined).catch(() => ({
    auth: undefined,
    config: {},
  }));
  const configuredProbe = createConfiguredGatewayLocalProbe(probeContext.config);
  let snapshot: GatewayPortHealthSnapshot = previousLockIdentity
    ? {
        portUsage: {
          port: params.port,
          status: "unknown",
          listeners: [],
          hints: [],
          errors: [
            `Previous gateway lock owner ${previousLockIdentity.ownerId ?? previousLockIdentity.pid} is still active.`,
          ],
        },
        healthy: false,
      }
    : await inspectGatewayPortHealth({
        port: params.port,
        auth: probeContext.auth,
        configuredProbe,
        includePluginHealth: params.includePluginHealth === true,
      });

  let attempt = 0;
  let expectedListenerPid: number | undefined;
  if (previousLockIdentity) {
    const replacement = await waitForGatewayLockReplacement({
      previousLockIdentity,
      attempts,
      delayMs,
      waitIndefinitelyForPreviousOwner: params.waitIndefinitelyForPreviousOwner === true,
    });
    if (replacement.status === "timeout") {
      return snapshot;
    }
    attempt = replacement.attemptsUsed;
    expectedListenerPid = replacement.lockIdentity.pid;
    snapshot = await inspectGatewayPortHealth({
      port: params.port,
      auth: probeContext.auth,
      configuredProbe,
      expectedListenerPid,
      includePluginHealth: params.includePluginHealth === true,
    });
  }

  if (snapshot.healthy) {
    return snapshot;
  }
  if (snapshot.activatedPluginErrors?.length || snapshot.unavailablePlugins?.length) {
    return snapshot;
  }
  while (attempt < attempts) {
    attempt += 1;
    await sleep(delayMs);
    snapshot = await inspectGatewayPortHealth({
      port: params.port,
      auth: probeContext.auth,
      configuredProbe,
      expectedListenerPid,
      includePluginHealth: params.includePluginHealth === true,
    });
    if (snapshot.healthy) {
      return snapshot;
    }
    if (snapshot.activatedPluginErrors?.length || snapshot.unavailablePlugins?.length) {
      return snapshot;
    }
  }

  return snapshot;
}
