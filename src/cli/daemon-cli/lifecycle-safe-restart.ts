import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { callGatewayCli } from "../../gateway/call.js";
import type { SafeGatewayRestartRequestResult } from "../../infra/restart-coordinator.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import { parseDurationMs } from "../parse-duration.js";
import { appendGatewayLifecycleAudit } from "./lifecycle-audit.js";
import type { DaemonLifecycleOptions } from "./types.js";

function formatSafeRestartWarnings(result: SafeGatewayRestartRequestResult): string[] | undefined {
  return result.preflight.blockers.length === 0 ? undefined : [result.preflight.summary];
}

export function resolveGatewayRestartIntentOptions(
  opts: DaemonLifecycleOptions,
): GatewayRestartIntent | undefined {
  if (opts.force && opts.wait !== undefined) {
    throw new Error("--force cannot be combined with --wait");
  }
  if (opts.force) {
    return { force: true };
  }
  return opts.wait === undefined ? undefined : { waitMs: parseDurationMs(opts.wait) };
}

/** Request an OpenClaw-aware restart through the running Gateway. */
type SafeRestartTarget = { pid: number; ownerId: string; port: number };

export async function runSafeGatewayRestart(
  opts: DaemonLifecycleOptions,
  target?: SafeRestartTarget,
): Promise<boolean> {
  if (opts.force) {
    throw new Error("--safe cannot be combined with --force; omit --safe to force restart now");
  }
  if (opts.wait !== undefined) {
    throw new Error("--safe cannot be combined with --wait; safe restart uses gateway deferral");
  }
  const skipDeferral = opts.skipDeferral === true;
  const params: {
    reason: string;
    safe?: true;
    skipDeferral?: true;
    target?: SafeRestartTarget;
  } = { reason: "gateway.restart.safe" };
  if (target) {
    params.safe = true;
    params.target = {
      pid: target.pid,
      ownerId: target.ownerId,
      port: target.port,
    };
  }
  if (skipDeferral) {
    params.skipDeferral = true;
  }
  const result = await callGatewayCli<SafeGatewayRestartRequestResult>({
    method: "gateway.restart.request",
    params,
    ...(target
      ? {
          ignoreEnvUrlOverride: true,
          localPortOverride: target.port,
          requiredCapabilities: [GATEWAY_SERVER_CAPS.GATEWAY_RESTART_TARGET_SAFE],
        }
      : {}),
    timeoutMs: 10_000,
  });
  if (target && result.restart.pid !== target.pid) {
    throw new Error("invalid safe restart acknowledgement");
  }
  appendGatewayLifecycleAudit({
    action: "restart",
    source: "safe-rpc",
    mode: result.status,
    pid: result.restart.pid,
  });
  const message =
    result.status === "coalesced"
      ? "safe restart request joined an existing pending gateway restart"
      : result.status === "deferred"
        ? "safe restart requested; gateway will restart after active work drains " +
          "(bounded wait; may force after the timeout expires)"
        : skipDeferral
          ? "safe restart requested; gateway bypassing active-work deferral"
          : "safe restart requested; gateway will restart momentarily";
  const payload = {
    ok: true,
    result: result.status,
    message,
    preflight: result.preflight,
    restart: result.restart,
    warnings: formatSafeRestartWarnings(result),
  };
  if (opts.json) {
    writeRuntimeJson(defaultRuntime, payload);
  } else {
    defaultRuntime.log(message);
    if (result.preflight.blockers.length > 0) {
      defaultRuntime.log(theme.warn(result.preflight.summary));
    }
  }
  return true;
}
