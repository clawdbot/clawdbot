import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodePairingGeneration } from "../../infra/device-pairing-node-state.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  sendApnsBackgroundWake,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import type { NodeSession } from "../node-registry.js";
import {
  captureNodeWakeLifecycle,
  isNodeWakeLifecycleCurrent,
  NODE_WAKE_RECONNECT_POLL_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  releaseNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
  type NodeWakeAttempt,
  type NodeWakeLifecycle,
  type NodeWakeNudgeAttempt,
} from "../node-wake-state.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { isNodePushAttemptCurrent, resolveDispatchableNodeSession } from "./nodes.shared.js";

async function resolveDirectNodePushConfig() {
  const auth = await resolveApnsAuthConfigFromEnv(process.env);
  return auth.ok
    ? { ok: true as const, auth: auth.value }
    : { ok: false as const, error: auth.error };
}

function resolveRelayNodePushConfig(
  cfg: OpenClawConfig,
  registration: Extract<
    NonNullable<Awaited<ReturnType<typeof loadApnsRegistration>>>,
    { transport: "relay" }
  >,
) {
  const relay = resolveApnsRelayConfigFromEnv(process.env, cfg.gateway, {
    registrationRelayOrigin: registration.relayOrigin,
  });
  return relay.ok
    ? { ok: true as const, relayConfig: relay.value }
    : { ok: false as const, error: relay.error };
}

async function clearStaleApnsRegistrationIfNeeded(
  registration: NonNullable<Awaited<ReturnType<typeof loadApnsRegistration>>>,
  nodeId: string,
  params: { status: number; reason?: string },
) {
  if (
    !shouldClearStoredApnsRegistration({
      registration,
      result: params,
    })
  ) {
    return;
  }
  await clearApnsRegistrationIfCurrent({
    nodeId,
    registration,
  });
}

async function delayMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function maybeWakeNodeWithApns(
  nodeId: string,
  opts?: {
    force?: boolean;
    wakeReason?: string;
    cfg?: OpenClawConfig;
    lifecycle?: NodeWakeLifecycle;
    generation?: NodePairingGeneration;
  },
): Promise<NodeWakeAttempt> {
  const lifecycleProvided = opts?.lifecycle !== undefined;
  const pairingGeneration = opts?.generation?.key;
  const lifecycle = opts?.lifecycle ?? captureNodeWakeLifecycle(nodeId, pairingGeneration);
  const isAttemptCurrent = () =>
    isNodePushAttemptCurrent({ nodeId, lifecycle, generation: opts?.generation });
  try {
    if (!(await isAttemptCurrent())) {
      return { available: false, throttled: false, path: "invalidated", durationMs: 0 };
    }
    const result = await runNodeWakeAttempt({
      nodeId,
      pairingGeneration,
      force: opts?.force === true,
      throttleMs: nodeInvokePolicy.wakeThrottleMs,
      attempt: async (markAttempted) => {
        const startedAtMs = performance.now();
        let attempted = false;
        const withDuration = (attempt: Omit<NodeWakeAttempt, "durationMs">): NodeWakeAttempt => ({
          ...attempt,
          durationMs: Math.round(performance.now() - startedAtMs),
        });
        const markWakeAttempted = () => {
          attempted = true;
          markAttempted();
        };

        try {
          if (!(await isAttemptCurrent())) {
            return withDuration({ available: false, throttled: false, path: "invalidated" });
          }
          const registration = await loadApnsRegistration(nodeId);
          if (!(await isAttemptCurrent())) {
            return withDuration({ available: false, throttled: false, path: "invalidated" });
          }
          if (!registration) {
            return withDuration({ available: false, throttled: false, path: "no-registration" });
          }

          let wakeResult;
          if (registration.transport === "relay") {
            const relay = resolveRelayNodePushConfig(opts?.cfg ?? getRuntimeConfig(), registration);
            if (!relay.ok) {
              return withDuration({
                available: false,
                throttled: false,
                path: "no-auth",
                apnsReason: relay.error,
              });
            }
            if (!(await isAttemptCurrent())) {
              return withDuration({ available: false, throttled: false, path: "invalidated" });
            }
            markWakeAttempted();
            wakeResult = await sendApnsBackgroundWake({
              registration,
              nodeId,
              wakeReason: opts?.wakeReason ?? "node.invoke",
              relayConfig: relay.relayConfig,
              signal: lifecycle,
              isCurrent: isAttemptCurrent,
            });
          } else {
            const auth = await resolveDirectNodePushConfig();
            if (!auth.ok) {
              return withDuration({
                available: false,
                throttled: false,
                path: "no-auth",
                apnsReason: auth.error,
              });
            }
            if (!(await isAttemptCurrent())) {
              return withDuration({ available: false, throttled: false, path: "invalidated" });
            }
            markWakeAttempted();
            wakeResult = await sendApnsBackgroundWake({
              registration,
              nodeId,
              wakeReason: opts?.wakeReason ?? "node.invoke",
              auth: auth.auth,
              signal: lifecycle,
              isCurrent: isAttemptCurrent,
            });
          }
          if (!(await isAttemptCurrent())) {
            return withDuration({ available: false, throttled: false, path: "invalidated" });
          }
          await clearStaleApnsRegistrationIfNeeded(registration, nodeId, wakeResult);
          if (!wakeResult.ok) {
            return withDuration({
              available: true,
              throttled: false,
              path: "send-error",
              apnsStatus: wakeResult.status,
              apnsReason: wakeResult.reason,
            });
          }
          return withDuration({
            available: true,
            throttled: false,
            path: "sent",
            apnsStatus: wakeResult.status,
            apnsReason: wakeResult.reason,
          });
        } catch (err) {
          if (!(await isAttemptCurrent())) {
            return withDuration({ available: false, throttled: false, path: "invalidated" });
          }
          return withDuration({
            available: attempted,
            throttled: false,
            path: "send-error",
            apnsReason: formatErrorMessage(err),
          });
        }
      },
    });
    return (await isAttemptCurrent())
      ? result
      : { available: false, throttled: false, path: "invalidated", durationMs: 0 };
  } finally {
    if (!lifecycleProvided) {
      releaseNodeWakeLifecycle(nodeId, lifecycle);
    }
  }
}

export async function maybeSendNodeWakeNudge(
  nodeId: string,
  opts?: {
    cfg?: OpenClawConfig;
    lifecycle?: NodeWakeLifecycle;
    generation?: NodePairingGeneration;
  },
): Promise<NodeWakeNudgeAttempt> {
  const startedAtMs = performance.now();
  const withDuration = (
    attempt: Omit<NodeWakeNudgeAttempt, "durationMs">,
  ): NodeWakeNudgeAttempt => ({
    ...attempt,
    durationMs: Math.round(performance.now() - startedAtMs),
  });
  const lifecycleProvided = opts?.lifecycle !== undefined;
  const pairingGeneration = opts?.generation?.key;
  const lifecycle = opts?.lifecycle ?? captureNodeWakeLifecycle(nodeId, pairingGeneration);
  const isAttemptCurrent = () =>
    isNodePushAttemptCurrent({ nodeId, lifecycle, generation: opts?.generation });
  try {
    if (!(await isAttemptCurrent())) {
      return withDuration({ sent: false, throttled: false, reason: "invalidated" });
    }
    return await runNodeWakeNudgeAttempt({
      nodeId,
      pairingGeneration,
      throttleMs: nodeInvokePolicy.wakeNudgeThrottleMs,
      throttled: () => withDuration({ sent: false, throttled: true, reason: "throttled" }),
      attempt: async () => {
        const registration = await loadApnsRegistration(nodeId);
        if (!(await isAttemptCurrent())) {
          return withDuration({ sent: false, throttled: false, reason: "invalidated" });
        }
        if (!registration) {
          return withDuration({ sent: false, throttled: false, reason: "no-registration" });
        }
        try {
          let result;
          if (registration.transport === "relay") {
            const relay = resolveRelayNodePushConfig(opts?.cfg ?? getRuntimeConfig(), registration);
            if (!relay.ok) {
              return withDuration({
                sent: false,
                throttled: false,
                reason: "no-auth",
                apnsReason: relay.error,
              });
            }
            if (!(await isAttemptCurrent())) {
              return withDuration({ sent: false, throttled: false, reason: "invalidated" });
            }
            result = await sendApnsAlert({
              registration,
              nodeId,
              title: "OpenClaw needs a quick reopen",
              body: "Tap to reopen OpenClaw and restore the node connection.",
              relayConfig: relay.relayConfig,
              signal: lifecycle,
              isCurrent: isAttemptCurrent,
            });
          } else {
            const auth = await resolveDirectNodePushConfig();
            if (!auth.ok) {
              return withDuration({
                sent: false,
                throttled: false,
                reason: "no-auth",
                apnsReason: auth.error,
              });
            }
            if (!(await isAttemptCurrent())) {
              return withDuration({ sent: false, throttled: false, reason: "invalidated" });
            }
            result = await sendApnsAlert({
              registration,
              nodeId,
              title: "OpenClaw needs a quick reopen",
              body: "Tap to reopen OpenClaw and restore the node connection.",
              auth: auth.auth,
              signal: lifecycle,
              isCurrent: isAttemptCurrent,
            });
          }
          if (!(await isAttemptCurrent())) {
            return withDuration({ sent: result.ok, throttled: false, reason: "invalidated" });
          }
          await clearStaleApnsRegistrationIfNeeded(registration, nodeId, result);
          if (!(await isAttemptCurrent())) {
            return withDuration({ sent: result.ok, throttled: false, reason: "invalidated" });
          }
          return result.ok
            ? withDuration({
                sent: true,
                throttled: false,
                reason: "sent",
                apnsStatus: result.status,
                apnsReason: result.reason,
              })
            : withDuration({
                sent: false,
                throttled: false,
                reason: "apns-not-ok",
                apnsStatus: result.status,
                apnsReason: result.reason,
              });
        } catch (err) {
          if (!(await isAttemptCurrent())) {
            return withDuration({ sent: false, throttled: false, reason: "invalidated" });
          }
          return withDuration({
            sent: false,
            throttled: false,
            reason: "send-error",
            apnsReason: formatErrorMessage(err),
          });
        }
      },
    });
  } finally {
    if (!lifecycleProvided) {
      releaseNodeWakeLifecycle(nodeId, lifecycle);
    }
  }
}

export async function waitForNodeReconnect(params: {
  nodeId: string;
  context: {
    nodeRegistry: {
      get: (nodeId: string) => NodeSession | undefined;
      getForPairingGeneration: (
        nodeId: string,
        pairingGeneration: string,
      ) => NodeSession | undefined;
    };
  };
  timeoutMs?: number;
  pollMs?: number;
  lifecycle?: NodeWakeLifecycle;
  pairingGeneration?: string;
}): Promise<boolean> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, NODE_WAKE_RECONNECT_WAIT_MS, 1);
  const pollMs = resolveTimerTimeoutMs(params.pollMs, NODE_WAKE_RECONNECT_POLL_MS, 50);
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    if (
      params.lifecycle &&
      !isNodeWakeLifecycleCurrent(params.nodeId, params.lifecycle, params.pairingGeneration)
    ) {
      return false;
    }
    const session = params.pairingGeneration
      ? params.context.nodeRegistry.getForPairingGeneration(params.nodeId, params.pairingGeneration)
      : params.context.nodeRegistry.get(params.nodeId);
    if (resolveDispatchableNodeSession(session)) {
      return true;
    }
    await delayMs(Math.min(pollMs, Math.max(0, deadline - performance.now())));
  }
  if (
    params.lifecycle &&
    !isNodeWakeLifecycleCurrent(params.nodeId, params.lifecycle, params.pairingGeneration)
  ) {
    return false;
  }
  const session = params.pairingGeneration
    ? params.context.nodeRegistry.getForPairingGeneration(params.nodeId, params.pairingGeneration)
    : params.context.nodeRegistry.get(params.nodeId);
  return Boolean(resolveDispatchableNodeSession(session));
}
