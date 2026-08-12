import {
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
/** systemd service enabled-state and runtime inspection. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceReadOptions,
} from "./service-types.js";
import {
  assertSystemdAvailable,
  execSystemctl,
  execSystemctlUser,
  isSystemctlMissing,
  isSystemdUnitNotEnabled,
  readSystemctlDetail,
} from "./systemd-exec.js";
import { findInstalledSystemdGatewayScope } from "./systemd-scope.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
  result?: string;
  nRestarts?: number;
  startLimitBurst?: number;
  unit?: string;
  killMode?: string;
  tasksCurrent?: number;
  memoryCurrent?: number;
};

function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) {
    info.activeState = activeState;
  }
  const subState = entries.substate;
  if (subState) {
    info.subState = subState;
  }
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = parseStrictPositiveInteger(mainPidValue);
    if (pid !== undefined) {
      info.mainPid = pid;
    }
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = parseStrictInteger(execMainStatusValue);
    if (status !== undefined) {
      info.execMainStatus = status;
    }
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) {
    info.execMainCode = execMainCode;
  }
  const result = entries.result;
  if (result) {
    info.result = result;
  }
  const nRestartsValue = entries.nrestarts;
  if (nRestartsValue) {
    const nRestarts = parseStrictInteger(nRestartsValue);
    if (nRestarts !== undefined) {
      info.nRestarts = nRestarts;
    }
  }
  const startLimitBurstValue = entries.startlimitburst;
  if (startLimitBurstValue) {
    const startLimitBurst = parseStrictInteger(startLimitBurstValue);
    if (startLimitBurst !== undefined) {
      info.startLimitBurst = startLimitBurst;
    }
  }
  const unit = entries.id;
  if (unit) {
    info.unit = unit;
  }
  const killMode = entries.killmode;
  if (killMode) {
    info.killMode = killMode;
  }
  const tasksCurrentValue = entries.taskscurrent;
  if (tasksCurrentValue) {
    const tasksCurrent = parseStrictNonNegativeInteger(tasksCurrentValue);
    if (tasksCurrent !== undefined) {
      info.tasksCurrent = tasksCurrent;
    }
  }
  const memoryCurrentValue = entries.memorycurrent;
  if (memoryCurrentValue) {
    const memoryCurrent = parseStrictNonNegativeInteger(memoryCurrentValue);
    if (memoryCurrent !== undefined) {
      info.memoryCurrent = memoryCurrent;
    }
  }
  return info;
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const env = args.env ?? process.env;
  const installed = await findInstalledSystemdGatewayScope(env);
  if (!installed) {
    return false;
  }
  const res =
    installed.scope === "system"
      ? await execSystemctl(["is-enabled", installed.unitName], env, args.timeoutMs)
      : await execSystemctlUser(env, ["is-enabled", installed.unitName], args.timeoutMs);
  if (res.code === 0) {
    return true;
  }
  const detail = readSystemctlDetail(res);
  if (isSystemctlMissing(detail) || isSystemdUnitNotEnabled(detail)) {
    return false;
  }
  throw new Error(`systemctl is-enabled unavailable: ${detail || "unknown error"}`.trim());
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceRuntime> {
  const timeoutMs = opts?.timeoutMs;
  const installed = await findInstalledSystemdGatewayScope(env).catch(() => null);
  if (installed?.scope !== "system") {
    try {
      await assertSystemdAvailable(env, timeoutMs);
    } catch (err) {
      return {
        status: "unknown",
        detail: formatErrorMessage(err),
      };
    }
  }
  const unitName = installed?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  const showArgs = [
    "show",
    unitName,
    "--no-page",
    "--property",
    "Id,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
  ];
  const res =
    installed?.scope === "system"
      ? await execSystemctl(showArgs, env, timeoutMs)
      : await execSystemctlUser(env, showArgs, timeoutMs);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = normalizeLowercaseStringOrEmpty(detail).includes("not found");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const activeState = normalizeLowercaseStringOrEmpty(parsed.activeState);
  const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
  return {
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
    systemd: {
      unit: parsed.unit ?? unitName,
      killMode: parsed.killMode,
      tasksCurrent: parsed.tasksCurrent,
      memoryCurrent: parsed.memoryCurrent,
      result: parsed.result,
      nRestarts: parsed.nRestarts,
      startLimitBurst: parsed.startLimitBurst,
    },
  };
}
