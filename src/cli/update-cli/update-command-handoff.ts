import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV, isGatewayServiceEnv } from "../../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { resolveInstallationTarget } from "../../infra/installation-target-context.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { getSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import {
  cancelManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
  transferManagedServiceUpdateHandoff,
} from "../../infra/update-managed-service-handoff.js";
import { buildUpdateRestartSentinelPayload } from "../../infra/update-restart-sentinel-payload.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { formatInstallationTargetCommand } from "../installation-target-format.js";
import { resolveNodeRunner, UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { resolveOwnedManagedUpdateEnv } from "./update-command-service-env.js";

function parsePositivePid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d+$/u.test(trimmed) ? (parseStrictPositiveInteger(trimmed) ?? null) : null;
}

export function gatewayAncestryBlockMessage(pid: unknown): string | undefined {
  const gatewayPid = parsePositivePid(pid);
  if (gatewayPid === null) {
    return undefined;
  }
  const inherited =
    isGatewayServiceEnv(process.env) &&
    parsePositivePid(process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV]) === gatewayPid;
  if (!inherited && !getSelfAndAncestorPidsSync().has(gatewayPid)) {
    return undefined;
  }
  // Shared by doctor and update: never advise stopping the service from here,
  // because the stop would kill the caller and nothing restarts the gateway.
  return `This command is running inside the gateway process tree (gateway PID ${gatewayPid}).
Stopping or restarting the gateway from here would kill this command, so it cannot safely manage the gateway that owns it.
Run this command from a shell outside the gateway service.`;
}

const ANCESTRY_BLOCK_MARKER = "inside the gateway process tree";

/** Update-specific follow-up for an ancestry block: the chat path hands off to the managed helper. */
export function formatUpdateAncestryBlockMessage(blockMessage: string): string {
  if (!blockMessage.includes(ANCESTRY_BLOCK_MARKER)) {
    return blockMessage;
  }
  return `${blockMessage}\nFrom chat, the OpenClaw owner can start the update with the gateway update action or /update, which hands it to a managed helper.`;
}

export async function handoffUpdateFromGateway(params: {
  state: GatewayServiceState;
  root: string;
  mode: UpdateRunResult["mode"];
  opts: UpdateCommandOptions;
  tag?: string;
  timeoutMs: number;
  devTarget?: DevUpdateTarget;
  nodeRunner?: string;
  invocationCwd?: string;
  stopProgress: () => void;
}): Promise<boolean> {
  if (
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
    (process.platform !== "linux" && process.platform !== "darwin")
  ) {
    return false;
  }
  const parentPid = parsePositivePid(params.state.runtime?.pid);
  const supervisor =
    detectRespawnSupervisor(process.env, process.platform, {
      includeLinuxOpenClawGatewayServiceMarker: true,
    }) ??
    (gatewayAncestryBlockMessage(parentPid)
      ? process.platform === "linux"
        ? "systemd"
        : "launchd"
      : null);
  if (!parentPid || !supervisor) {
    return false;
  }
  params.stopProgress();
  const env = resolveOwnedManagedUpdateEnv({
    serviceEnv: params.state.env,
    serviceDefinitionEnv: resolveManagedGatewayServiceCommand(params.state.command)?.environment,
    invocationCwd: params.invocationCwd,
  });
  const argv1 = await resolveGatewayInstallEntrypoint(params.root);
  if (!argv1) {
    throw new UpdatePreMutationError(
      "managed-service-handoff-failed",
      "Cannot locate the installed updater; run `openclaw doctor` before retrying.",
    );
  }
  const started = await startManagedServiceUpdateHandoff({
    runId: params.opts.run?.runId,
    root: params.root,
    invocationCwd: params.invocationCwd,
    parentPid,
    supervisor,
    env,
    execPath: params.nodeRunner ?? resolveNodeRunner(),
    argv1,
    timeoutMs: params.timeoutMs,
    restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
    channel: normalizeUpdateChannel(params.opts.channel) ?? undefined,
    tag: params.tag,
    devTarget: params.devTarget,
    acceptCapabilities: params.opts.acceptCapabilities,
    meta: { runId: params.opts.run?.runId },
  });
  if (started.status === "joined") {
    throw new UpdatePreMutationError(
      "managed-service-handoff-already-running",
      "Another managed update is already running. Inspect `openclaw status --all` before retrying.",
    );
  }
  const identity = {
    kind: "managed-update-handoff" as const,
    handoffId: started.handoffId,
    installRoot: started.installRoot,
  };
  const target = resolveInstallationTarget(env);
  const statusCommand = formatInstallationTargetCommand(["openclaw", "status", "--all"], target, {
    env,
  });
  const healthCommand = formatInstallationTargetCommand(
    ["openclaw", "gateway", "status", "--deep"],
    target,
    { env },
  );
  const guidance = `Update continues outside the Gateway process. Log: ${started.logPath}\nFollow up: ${statusCommand}; ${healthCommand}.`;
  const result: UpdateRunResult = {
    runId: params.opts.run?.runId,
    status: "skipped",
    mode: params.mode,
    root: started.installRoot,
    reason: CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
    steps: [
      {
        name: "managed-service update handoff",
        command: started.command,
        cwd: started.installRoot,
        durationMs: 0,
        exitCode: null,
        stdoutTail: guidance,
      },
    ],
    durationMs: 0,
  };
  try {
    await writeRestartSentinel(
      buildUpdateRestartSentinelPayload({
        result,
        meta: {
          runId: params.opts.run?.runId,
          handoffId: started.handoffId,
          root: started.installRoot,
        },
      }),
      env,
    );
    if (!(await transferManagedServiceUpdateHandoff(identity))) {
      throw new Error(
        `Managed update ownership transfer failed. Inspect ${started.logPath} and run ${healthCommand} before retrying.`,
      );
    }
  } catch (error) {
    await cancelManagedServiceUpdateHandoff(identity);
    throw error;
  }
  if (params.opts.json) {
    defaultRuntime.writeJson(result);
  } else {
    defaultRuntime.log(guidance);
  }
  if (params.opts.run) {
    recordUpdateRunStep(
      params.opts.run.runId,
      { step: "managed-service update handoff", status: "completed", endedAtMs: Date.now() },
      { env: params.opts.run.env },
    );
  }
  return true;
}
