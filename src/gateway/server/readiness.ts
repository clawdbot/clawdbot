// Gateway readiness checker for channel health and startup sidecar state.
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { ReadinessCondition, CanonicalReadinessResult } from "../../readiness/conditions.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  type ChannelHealthPolicy,
  type ChannelHealthEvaluation,
} from "../channel-health-policy.js";
import type { ChannelManager } from "../server-channels.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/** Snapshot returned by the gateway readiness probe. */
type ReadinessResult = {
  ready: boolean;
  failing: string[];
  suppressed?: string[];
  uptimeMs: number;
  eventLoop?: GatewayEventLoopHealth;
  conditions?: ReadinessCondition[];
  failures?: string[];
  advisories?: string[];
};

export type CanonicalGatewayReadinessResult = ReadinessResult & CanonicalReadinessResult;

/** Function form used by HTTP readiness endpoints and tests. */
export type ReadinessChecker = () => ReadinessResult | Promise<ReadinessResult>;

const DEFAULT_READINESS_CACHE_TTL_MS = 1_000;
const DEFAULT_READINESS_EVALUATION_TIMEOUT_MS = 2_000;

class ReadinessEvaluationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`readiness evaluation exceeded ${timeoutMs}ms`);
    this.name = "ReadinessEvaluationTimeoutError";
  }
}

async function withReadinessEvaluationTimeout<T>(
  evaluation: Promise<T>,
  timeoutMs = DEFAULT_READINESS_EVALUATION_TIMEOUT_MS,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      evaluation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ReadinessEvaluationTimeoutError(timeoutMs)),
          Math.max(1, timeoutMs),
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function buildReadinessEvaluationFailure(error: unknown): CanonicalReadinessResult {
  const timedOut = error instanceof ReadinessEvaluationTimeoutError;
  const reason = timedOut ? "ReadinessEvaluationTimedOut" : "ReadinessEvaluationFailed";
  return {
    ready: false,
    conditions: [
      {
        type: "ReadinessEvaluationComplete",
        status: "Unknown",
        requirement: "required",
        reason,
        message: timedOut
          ? "Readiness evaluation did not complete within its bounded deadline."
          : "Readiness evaluation could not be completed.",
      },
    ],
    failures: [reason],
    advisories: [],
  };
}

function buildCoreCondition(params: {
  type: ReadinessCondition["type"];
  status: ReadinessCondition["status"];
  requirement?: ReadinessCondition["requirement"];
  reason: string;
  message: string;
}): ReadinessCondition {
  return {
    type: params.type,
    status: params.status,
    requirement: params.requirement ?? "required",
    reason: params.reason,
    message: params.message,
  };
}

function buildStartupCondition(pending: boolean, pendingReason?: string): ReadinessCondition {
  return buildCoreCondition({
    type: "GatewayStartupComplete",
    status: pending ? "False" : "True",
    reason: pending ? "GatewayStartupPending" : "GatewayStartupComplete",
    message: pending
      ? `Gateway startup dependencies are still pending${pendingReason ? `: ${pendingReason}` : ""}.`
      : "Gateway startup dependencies are complete.",
  });
}

function buildSuppressedChannelCondition(suppressed: string[]): ReadinessCondition | undefined {
  if (suppressed.length === 0) {
    return undefined;
  }
  return buildCoreCondition({
    type: "ChannelRuntimeSuppressed",
    status: "False",
    requirement: "advisory",
    reason: "ChannelRuntimeSuppressed",
    message: `Channel runtime failures are suppressed: ${suppressed.join(", ")}.`,
  });
}

function buildAcceptingWorkCondition(draining: boolean): ReadinessCondition {
  return buildCoreCondition({
    type: "GatewayAcceptingWork",
    status: draining ? "False" : "True",
    reason: draining ? "GatewayDraining" : "GatewayAcceptingWork",
    message: draining
      ? "Gateway is draining and is not accepting new work."
      : "Gateway is accepting new work.",
  });
}

function buildChannelCondition(params: {
  checked: boolean;
  failing: string[];
}): ReadinessCondition {
  if (!params.checked) {
    return buildCoreCondition({
      type: "ChannelRuntimeReady",
      status: "Unknown",
      reason: "ChannelRuntimeNotChecked",
      message: "Channel runtime health was not evaluated on this readiness pass.",
    });
  }
  if (params.failing.length > 0) {
    return buildCoreCondition({
      type: "ChannelRuntimeReady",
      status: "False",
      reason: "ChannelRuntimeUnavailable",
      message: `Selected channels are not ready: ${params.failing.join(", ")}.`,
    });
  }
  return buildCoreCondition({
    type: "ChannelRuntimeReady",
    status: "True",
    reason: "ChannelRuntimeReady",
    message: "Selected channel runtimes are ready.",
  });
}

function buildEventLoopCondition(
  eventLoop: GatewayEventLoopHealth | undefined,
): ReadinessCondition {
  if (!eventLoop) {
    return buildCoreCondition({
      type: "EventLoopHealthy",
      status: "Unknown",
      requirement: "advisory",
      reason: "EventLoopStatusUnavailable",
      message: "Event-loop health is not available yet.",
    });
  }
  return buildCoreCondition({
    type: "EventLoopHealthy",
    status: eventLoop.degraded ? "False" : "True",
    requirement: "advisory",
    reason: eventLoop.degraded ? "EventLoopDegraded" : "EventLoopHealthy",
    message: eventLoop.degraded
      ? `Event-loop health is degraded: ${eventLoop.reasons.join(", ")}.`
      : "Event-loop health is within its healthy thresholds.",
  });
}

function shouldIgnoreReadinessFailure(
  accountSnapshot: ChannelAccountSnapshot,
  health: ChannelHealthEvaluation,
  autostartSuppressed: boolean,
): boolean {
  if (health.reason === "unmanaged" || health.reason === "stale-socket") {
    return true;
  }
  if (autostartSuppressed && health.reason === "not-running") {
    return true;
  }
  // Channel restarts spend time in backoff with running=false before the next
  // lifecycle re-enters startup grace. Keep readiness green during that handoff
  // window, but still surface hard failures once restart attempts are exhausted.
  return health.reason === "not-running" && accountSnapshot.restartPending === true;
}

/** Create a cached readiness checker over channel runtime health. */
export function createReadinessChecker(deps: {
  channelManager: ChannelManager;
  startedAt: number;
  getStartupPending?: () => boolean;
  getStartupPendingReason?: () => string | undefined;
  getGatewayDraining?: () => boolean;
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined;
  shouldSkipChannelReadiness?: () => boolean;
  cacheTtlMs?: number;
}): ReadinessChecker {
  const { channelManager, startedAt } = deps;
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? DEFAULT_READINESS_CACHE_TTL_MS);
  let cachedAt = 0;
  let cachedState: Omit<ReadinessResult, "uptimeMs"> | null = null;

  return (): ReadinessResult => {
    const now = Date.now();
    const uptimeMs = now - startedAt;
    const startupPending = deps.getStartupPending?.() === true;
    const startupPendingReason = startupPending ? deps.getStartupPendingReason?.() : undefined;
    const gatewayDraining = deps.getGatewayDraining?.() === true;
    const lifecycleConditions = [
      buildStartupCondition(startupPending, startupPendingReason),
      buildAcceptingWorkCondition(gatewayDraining),
    ];
    if (startupPending) {
      const reason = startupPendingReason ?? "startup-sidecars";
      return withEventLoopHealth(
        {
          ready: false,
          failing: [reason],
          uptimeMs,
          conditions: [
            ...lifecycleConditions,
            buildChannelCondition({ checked: false, failing: [] }),
          ],
        },
        deps.getEventLoopHealth,
      );
    }
    if (gatewayDraining) {
      return withEventLoopHealth(
        {
          ready: false,
          failing: ["gateway-draining"],
          uptimeMs,
          conditions: [
            ...lifecycleConditions,
            buildChannelCondition({ checked: false, failing: [] }),
          ],
        },
        deps.getEventLoopHealth,
      );
    }
    if (deps.shouldSkipChannelReadiness?.()) {
      return withEventLoopHealth(
        {
          ready: true,
          failing: [],
          uptimeMs,
          conditions: [
            ...lifecycleConditions,
            buildChannelCondition({ checked: true, failing: [] }),
          ],
        },
        deps.getEventLoopHealth,
      );
    }
    if (cachedState && now - cachedAt < cacheTtlMs) {
      return withEventLoopHealth({ ...cachedState, uptimeMs }, deps.getEventLoopHealth);
    }

    const snapshot = channelManager.getRuntimeSnapshot();
    const globallyAutostartSuppressed = channelManager.getAutostartSuppression() !== null;
    const failing: string[] = [];
    const suppressed: string[] = [];

    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      if (!accounts) {
        continue;
      }
      const autostartSuppressed =
        globallyAutostartSuppressed || channelManager.isAmbientAutostartSuppressed(channelId);
      for (const accountSnapshot of Object.values(accounts)) {
        if (!accountSnapshot) {
          continue;
        }
        const policy: ChannelHealthPolicy = {
          now,
          staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
          channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          channelId,
        };
        const health = evaluateChannelHealth(accountSnapshot, policy);
        if (!health.healthy && autostartSuppressed && health.reason === "not-running") {
          if (!suppressed.includes(channelId)) {
            suppressed.push(channelId);
          }
          continue;
        }
        if (
          !health.healthy &&
          !shouldIgnoreReadinessFailure(accountSnapshot, health, autostartSuppressed)
        ) {
          failing.push(channelId);
          break;
        }
      }
    }

    cachedAt = now;
    const suppressedCondition = buildSuppressedChannelCondition(suppressed);
    cachedState = {
      ready: failing.length === 0,
      failing,
      ...(suppressed.length > 0 ? { suppressed } : {}),
      conditions: [
        ...lifecycleConditions,
        buildChannelCondition({ checked: true, failing }),
        ...(suppressedCondition ? [suppressedCondition] : []),
      ],
    };
    return withEventLoopHealth({ ...cachedState, uptimeMs }, deps.getEventLoopHealth);
  };
}

function withEventLoopHealth(
  result: ReadinessResult,
  getEventLoopHealth?: () => GatewayEventLoopHealth | undefined,
): ReadinessResult {
  const eventLoop = getEventLoopHealth?.();
  return {
    ...result,
    ...(eventLoop ? { eventLoop } : {}),
    conditions: [
      ...(result.conditions ?? []).filter((condition) => condition.type !== "EventLoopHealthy"),
      buildEventLoopCondition(eventLoop),
    ],
  };
}

function mergeReadinessResults(
  gateway: ReadinessResult,
  runtime: CanonicalReadinessResult,
): CanonicalGatewayReadinessResult {
  const conditions = [...(gateway.conditions ?? []), ...runtime.conditions];
  const failures = Array.from(
    new Set(
      conditions
        .filter((condition) => condition.requirement === "required" && condition.status !== "True")
        .map((condition) => condition.reason),
    ),
  );
  const advisories = Array.from(
    new Set(
      conditions
        .filter((condition) => condition.requirement === "advisory" && condition.status !== "True")
        .map((condition) => condition.reason),
    ),
  );
  return {
    ...gateway,
    ready: failures.length === 0,
    failing: Array.from(new Set([...gateway.failing, ...runtime.failures])),
    conditions,
    failures,
    advisories,
  };
}

export async function evaluateCanonicalGatewayReadiness(params: {
  evaluateGateway: ReadinessChecker;
  evaluateRuntime: () => Promise<CanonicalReadinessResult>;
  timeoutMs?: number;
}): Promise<CanonicalGatewayReadinessResult> {
  let gateway: ReadinessResult | undefined;
  try {
    return await withReadinessEvaluationTimeout(
      Promise.resolve().then(async () => {
        gateway = await params.evaluateGateway();
        const runtime = await params.evaluateRuntime();
        return mergeReadinessResults(gateway, runtime);
      }),
      params.timeoutMs,
    );
  } catch (error) {
    return mergeReadinessResults(
      gateway ?? { ready: false, failing: [], uptimeMs: 0 },
      buildReadinessEvaluationFailure(error),
    );
  }
}
