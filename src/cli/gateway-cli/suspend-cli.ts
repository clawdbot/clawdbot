import { randomBytes } from "node:crypto";
import type {
  GatewaySuspendPrepareResult,
  GatewaySuspendResumeResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import type { callGatewayFromCliWithTransport } from "../gateway-rpc.js";

type SuspendRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

type SuspendRpcCall = (method: string, opts: SuspendRpcOpts, params?: unknown) => Promise<unknown>;

type SuspendCliDeps = {
  callGateway: SuspendRpcCall;
  runtime: OutputRuntimeEnv;
  nowMs?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

const MIN_SUSPEND_POLL_DELAY_MS = 50;

function parseWaitMs(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("--wait must be a non-negative number of seconds");
  }
  const milliseconds = Math.floor(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("--wait is too large");
  }
  return milliseconds;
}

function resolveRequestId(value: string | undefined): string {
  if (value === undefined) {
    return `cli-${randomBytes(4).toString("hex")}`;
  }
  const requestId = value.trim();
  if (!requestId || requestId.length > 128) {
    throw new Error("--request-id must contain 1 to 128 characters");
  }
  return requestId;
}

function formatBusyResult(
  result: Extract<GatewaySuspendPrepareResult, { status: "busy" }>,
): string {
  const blockers = result.blockers.map((blocker) => `- ${blocker.message}`);
  return [
    `Gateway suspension is busy (${result.reason}; ${result.activeCount} active).`,
    ...(blockers.length > 0 ? ["Blockers:", ...blockers] : []),
  ].join("\n");
}

export async function runGatewaySuspend(
  options: {
    rpcOpts: SuspendRpcOpts;
    requestId?: string;
    waitSeconds?: string | number;
    json?: boolean;
  },
  deps: SuspendCliDeps,
): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now;
  const sleep =
    deps.sleep ??
    (async (delayMs: number) =>
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  const requestId = resolveRequestId(options.requestId);
  const waitMs = parseWaitMs(options.waitSeconds);
  const deadlineMs = waitMs === undefined ? undefined : nowMs() + waitMs;
  const maxAttempts = waitMs === undefined ? 1 : Math.ceil(waitMs / MIN_SUSPEND_POLL_DELAY_MS) + 1;
  let latest: GatewaySuspendPrepareResult | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // A sleep can overshoot the deadline; never issue a prepare that could
    // suspend the Gateway after the operator's advertised --wait window.
    if (attempt > 0 && deadlineMs !== undefined && nowMs() >= deadlineMs) {
      break;
    }
    latest = (await deps.callGateway("gateway.suspend.prepare", options.rpcOpts, {
      requestId,
    })) as GatewaySuspendPrepareResult;
    if (latest.status === "ready") {
      if (options.json) {
        deps.runtime.writeJson({ ...latest, requestId });
        return;
      }
      const rich = isRich();
      deps.runtime.log(colorize(rich, theme.success, "Gateway suspension prepared."));
      deps.runtime.log(`${colorize(rich, theme.muted, "Suspension ID:")} ${latest.suspensionId}`);
      deps.runtime.log(
        `${colorize(rich, theme.muted, "Expires:")} ${new Date(latest.expiresAtMs).toISOString()} (${latest.expiresAtMs} ms)`,
      );
      const port = options.rpcOpts.localPortOverride;
      const command = `openclaw gateway resume ${latest.suspensionId}`;
      deps.runtime.log(
        `Resume with: ${formatCliCommand(port === undefined ? command : `${command} --port ${port}`)}`,
      );
      return;
    }

    if (deadlineMs === undefined) {
      if (options.json) {
        deps.runtime.writeJson({ ...latest, requestId });
        deps.runtime.exit(1);
        return;
      }
      throw new Error(`${formatBusyResult(latest)}\nRetry later or use --wait <seconds>.`);
    }

    const remainingMs = deadlineMs - nowMs();
    if (remainingMs <= 0) {
      break;
    }
    const delayMs = Math.min(remainingMs, Math.max(MIN_SUSPEND_POLL_DELAY_MS, latest.retryAfterMs));
    await sleep(delayMs);
  }

  if (!latest || latest.status !== "busy") {
    throw new Error("Gateway suspension polling ended without a result");
  }
  if (options.json) {
    deps.runtime.writeJson({ ...latest, requestId });
    deps.runtime.exit(1);
    return;
  }
  throw new Error(`${formatBusyResult(latest)}\nTimed out waiting for the Gateway to become idle.`);
}

export async function runGatewayResume(
  options: { rpcOpts: SuspendRpcOpts; suspensionId: string; json?: boolean },
  deps: Pick<SuspendCliDeps, "callGateway" | "runtime">,
): Promise<void> {
  const result = (await deps.callGateway("gateway.suspend.resume", options.rpcOpts, {
    suspensionId: options.suspensionId,
  })) as GatewaySuspendResumeResult;
  if (options.json) {
    deps.runtime.writeJson(result);
    return;
  }
  deps.runtime.log(
    result.resumed
      ? "Gateway resumed."
      : "No matching suspension was held (lease already expired or resumed); gateway is running.",
  );
}
