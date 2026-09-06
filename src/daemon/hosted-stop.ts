import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { formatExternalSupervisorActionRequired } from "../infra/gateway-supervision.js";
import type { detectGatewayRespawnSupervisor } from "../infra/supervisor-markers.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { probeLaunchAgentState, resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import { execSystemctl } from "./systemd-exec.js";

type HostedGatewayStopResult =
  | { outcome: "accepted" }
  | { outcome: "exit" }
  | { outcome: "refused"; detail: string }
  | { outcome: "uncertain"; detail: string };

export type HostedGatewayStop = {
  execute(assertCurrent: () => void): Promise<HostedGatewayStopResult>;
  dispose(): Promise<void>;
};

export type GatewayProcessOwner = {
  ownsProcessLifecycle: boolean;
  supervisor: ReturnType<typeof detectGatewayRespawnSupervisor>;
};

async function readProcessCgroup(pid: number): Promise<string> {
  const cgroups = await fs.readFile(`/proc/${pid}/cgroup`, "utf8");
  const cgroup = cgroups.split("\n").find((line) => /^(?:0:|\d+:name=systemd):/.test(line));
  if (!cgroup) {
    throw new Error(
      "Cannot verify the Gateway's native systemd cgroup. Stop it from an external shell.",
    );
  }
  return cgroup.slice(cgroup.indexOf(":", cgroup.indexOf(":") + 1) + 1);
}

/** Discovery is request-bound; only the returned executor can cross its planned kernel teardown. */
export async function prepareHostedGatewayStop(
  owner: GatewayProcessOwner,
  assertCaller: () => void,
  signal: AbortSignal,
): Promise<HostedGatewayStop> {
  const env = { ...process.env };
  signal.throwIfAborted();
  assertCaller();
  if (!owner.ownsProcessLifecycle) {
    throw new Error("This Gateway host does not own the process lifecycle.");
  }
  if (owner.supervisor === "external") {
    throw new Error(formatExternalSupervisorActionRequired("stop"));
  }
  if (
    owner.supervisor === null ||
    (process.platform === "win32" && owner.supervisor === "schtasks")
  ) {
    // Exit only the process this run loop owns, never a task selected by name.
    // The generated Windows task supervisor propagates clean exit after extinction;
    // its RestartOnFailure policy does not restart a successful task.
    return {
      async execute(assertCurrent) {
        signal.throwIfAborted();
        assertCurrent();
        return { outcome: "exit" };
      },
      async dispose() {},
    };
  }
  const pid = process.pid;
  const start = getFileLockProcessStartTime(pid);
  if (start === null) {
    throw new Error("Cannot verify the Gateway process identity. Stop it from an external shell.");
  }
  const assertProcess = (assertCurrent: () => void) => {
    signal.throwIfAborted();
    assertCurrent();
    if (getFileLockProcessStartTime(pid) !== start) {
      throw new Error("Gateway process identity changed before native stop.");
    }
  };
  const assertPreparing = () => assertProcess(assertCaller);
  assertPreparing();
  if (process.platform === "darwin") {
    const target = `${resolveLaunchAgentGuiDomain()}/${resolveLaunchAgentLabel(env)}`;
    const inspect = async (assertCurrent: () => void) => {
      const current = await probeLaunchAgentState(target, 5_000);
      assertProcess(assertCurrent);
      // launchctl also prints nested coalition states. The probe's canonical
      // status, not its raw diagnostic state, describes the running job.
      if (current.state !== "running" || current.runtime.pid !== pid) {
        throw new Error("LaunchAgent no longer owns this exact Gateway process.");
      }
    };
    await inspect(assertPreparing);
    const executor = await prepareHostedStopExecutor({
      command: ["/bin/launchctl", "bootout", target],
      env,
      signal,
      assertCurrent: assertPreparing,
    });
    try {
      await inspect(assertPreparing);
      assertPreparing();
    } catch (error) {
      await executor.dispose();
      throw error;
    }
    return {
      dispose: executor.dispose,
      async execute(assertCurrent) {
        await inspect(assertCurrent);
        const result = await executor.execute(() => assertProcess(assertCurrent));
        assertProcess(assertCurrent);
        if (result.disposition === "accepted") {
          return { outcome: "accepted" };
        }
        // Neither child termination nor a still-visible job proves that bootout
        // was rejected. Never resurrect a generation on an ambiguous native result.
        return {
          outcome: "uncertain",
          detail: `launchctl bootout acceptance unconfirmed: ${result.detail}`,
        };
      },
    };
  }
  if (process.platform !== "linux") {
    throw new Error(
      "Hosted native Gateway stop is unavailable on this platform. Use the host's service manager.",
    );
  }

  const cgroup = await readProcessCgroup(pid);
  assertPreparing();
  const unit = cgroup.split("/").at(-1);
  if (!unit || !/^[A-Za-z0-9_.:@\\-]+\.service$/.test(unit)) {
    throw new Error(
      "This Gateway is not the main process of a systemd service. Stop it through the host that started it.",
    );
  }
  const uid = process.getuid?.();
  const scope =
    uid !== undefined && cgroup.includes(`/user@${uid}.service/`) ? "--user" : "--system";
  // Freeze one manager route. Do not use installed-service discovery's user-first
  // fallback, which can select a different Gateway when both scopes exist.
  const readIdentity = async (assertCurrent: () => void) => {
    const current = await execSystemctl(
      [
        scope,
        "show",
        "--all",
        unit,
        "--property=Id,LoadState,ActiveState,SubState,MainPID,ControlGroup,InvocationID,ExecMainStartTimestampMonotonic,Job,CanStop,RefuseManualStop",
      ],
      env,
      5_000,
    );
    assertProcess(assertCurrent);
    const fields = parseKeyValueOutput(current.stdout, "=");
    if (
      current.code !== 0 ||
      fields.id !== unit ||
      fields.loadstate !== "loaded" ||
      fields.activestate !== "active" ||
      fields.substate !== "running" ||
      fields.mainpid !== String(pid) ||
      fields.controlgroup !== cgroup ||
      !/^[a-f0-9]{32}$/i.test(fields.invocationid ?? "") ||
      !/^[1-9]\d*$/.test(fields.execmainstarttimestampmonotonic ?? "") ||
      !/^(?:0|)$/.test(fields.job ?? "missing")
    ) {
      throw new Error(
        "systemd no longer identifies this exact active Gateway without a pending job.",
      );
    }
    // The unit/PID/cgroup and execution generation identify this Gateway;
    // the service manager's own process is not the resource being stopped.
    return {
      identity: `${fields.invocationid}:${fields.execmainstarttimestampmonotonic}`,
      canStop: fields.canstop === "yes" && fields.refusemanualstop === "no",
    };
  };
  const initial = await readIdentity(assertPreparing);
  assertPreparing();
  if (!initial.canStop) {
    throw new Error(
      "systemd does not permit manual stop of this Gateway service. Use its owning supervisor.",
    );
  }
  const scopeUnit = `openclaw-stop-${randomUUID()}.scope`;
  const executor = await prepareHostedStopExecutor({
    command: ["systemctl", scope, "--no-ask-password", "--no-block", "stop", unit],
    scopeArgs: [
      scope,
      "--scope",
      "--quiet",
      "--collect",
      "--no-ask-password",
      `--unit=${scopeUnit}`,
    ],
    env,
    signal,
    assertCurrent: assertPreparing,
    verifyPlacement: async (executorPid) => {
      const executorCgroup = await readProcessCgroup(executorPid);
      assertPreparing();
      if (!executorCgroup.endsWith(`/${scopeUnit}`) || executorCgroup.startsWith(`${cgroup}/`)) {
        throw new Error("Native stop executor did not leave the Gateway service cgroup.");
      }
    },
  });
  const assertIdentity = async (assertCurrent: () => void) => {
    const current = await readIdentity(assertCurrent);
    if (current.identity !== initial.identity) {
      throw new Error("Native Gateway service instance changed before stop.");
    }
    assertProcess(assertCurrent);
    return current.canStop;
  };
  try {
    if (!(await assertIdentity(assertPreparing))) {
      throw new Error("systemd no longer permits manual stop of this Gateway service.");
    }
  } catch (error) {
    await executor.dispose();
    throw error;
  }
  return {
    dispose: executor.dispose,
    async execute(assertCurrent) {
      try {
        if (!(await assertIdentity(assertCurrent))) {
          return {
            outcome: "refused",
            detail: "systemd no longer permits manual stop of this Gateway service",
          };
        }
        const result = await executor.execute(() => assertProcess(assertCurrent));
        assertProcess(assertCurrent);
        if (result.disposition === "accepted") {
          return { outcome: "accepted" };
        }
        if (result.disposition === "refused") {
          // An explicit command rejection plus the same active generation with
          // no native job permits reopening. Lost transport never permits it.
          await assertIdentity(assertCurrent);
          return { outcome: "refused", detail: `systemd refused Gateway stop: ${result.detail}` };
        }
        return {
          outcome: "uncertain",
          detail: `systemd stop acceptance unconfirmed: ${result.detail}`,
        };
      } catch (error) {
        return {
          outcome: "uncertain",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
