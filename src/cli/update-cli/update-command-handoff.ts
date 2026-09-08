import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV, isGatewayServiceEnv } from "../../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceState,
} from "../../daemon/service-types.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { resolveInstallationTarget } from "../../infra/installation-target-context.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { getSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  cancelManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
  transferManagedServiceUpdateHandoff,
} from "../../infra/update-managed-service-handoff.js";
import { buildUpdateRestartSentinelPayload } from "../../infra/update-restart-sentinel-payload.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { formatInstallationTargetCommand } from "../installation-target-format.js";
import { printResult } from "./progress.js";
import { resolveNodeRunner, UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import { resolveOwnedManagedUpdateEnv } from "./update-command-service-env.js";

function parsePositivePid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d+$/u.test(trimmed) ? (parseStrictPositiveInteger(trimmed) ?? null) : null;
}

const GATEWAY_ANCESTRY_SHELL_GUIDANCE =
  "Run this command from a shell outside the gateway service.";

function gatewayAncestryBlockMessage(pid: unknown): string | undefined {
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
${GATEWAY_ANCESTRY_SHELL_GUIDANCE}`;
}

const ANCESTRY_BLOCK_MARKER = "inside the gateway process tree";
const UPDATE_CHAT_HANDOFF_GUIDANCE =
  "From chat, the OpenClaw owner can start the update with the gateway update action or /update, which hands it to a managed helper.";

function appendUpdateChatHandoffGuidance(blockMessage: string): string {
  return blockMessage.includes(UPDATE_CHAT_HANDOFF_GUIDANCE)
    ? blockMessage
    : `${blockMessage}\n${UPDATE_CHAT_HANDOFF_GUIDANCE}`;
}

/** Update-specific follow-up for an ancestry block: the chat path hands off to the managed helper. */
export function formatUpdateAncestryBlockMessage(blockMessage: string): string {
  if (!blockMessage.includes(ANCESTRY_BLOCK_MARKER)) {
    return blockMessage;
  }
  const updateBlockMessage = blockMessage
    .split("\n")
    .filter((line) => line !== GATEWAY_ANCESTRY_SHELL_GUIDANCE)
    .join("\n");
  return appendUpdateChatHandoffGuidance(updateBlockMessage);
}

export function gatewayMaintenanceBlockMessage(
  state: GatewayServiceState,
  root: string,
  operation: "stop" | "handoff" = "stop",
): string | undefined {
  const ancestors = getSelfAndAncestorPidsSync();
  const store = createManagedHandoffLeaseStore();
  const claim = store.read(resolveUpdateInstallRoot(root));
  const lease = claim.kind === "current" ? claim.lease : undefined;
  // PartOf makes a primary stop terminal for its separately supervised fixer.
  // A current lease plus exact live ancestry only refuses self-stop; copied
  // environment or claims never grant maintenance or cancellation exemptions.
  if (
    lease?.action.kind === "triage" &&
    lease.action.phase === "running" &&
    lease.action.lifetime.kind === "native" &&
    lease.action.lifetime.placement.kind === "attached" &&
    lease.action.lifetime.unit === `${resolveSystemdServiceName(state.env)}.service` &&
    [lease.executor, lease.helper].every(
      (owner) =>
        ancestors.has(owner.pid) &&
        isPidAlive(owner.pid) &&
        store.readProcessStartIdentity(owner.pid) === owner.startIdentity,
    )
  ) {
    return "This maintenance command cannot stop the Gateway from inside its automatic triage process tree: stopping the service would cancel this repair. Use read-only diagnosis or safe offline artifact repair followed by an atomic `openclaw gateway restart`, or run stop-requiring maintenance from a shell outside automatic triage. Report this blocker if repair cannot proceed safely.";
  }
  return operation === "handoff" ? undefined : gatewayAncestryBlockMessage(state.runtime?.pid);
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
  if (params.opts.run) {
    recordUpdateRunStep(
      params.opts.run.runId,
      { step: "managed-service update handoff", status: "completed", endedAtMs: Date.now() },
      { env: params.opts.run.env },
    );
  }
  printResult(result, params.opts);
  if (!params.opts.json) {
    defaultRuntime.log(guidance);
  }
  return true;
}
