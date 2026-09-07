// Read already-loaded user-manager state without loading a unit or starting a bus service.
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createServiceRuntimeInspectionFailure,
  type GatewayServiceRuntime,
} from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { execBusctlUser } from "./systemd-exec.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

const MANAGER = "org.freedesktop.systemd1";
const BUS = "org.freedesktop.DBus";
const isUint32 = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const isInt32 = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= -0x80000000 &&
  value <= 0x7fffffff;
const optionalCounter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Update admission already selects the user manager; missing/changed objects remain unknown. */
export async function readLoadedSystemdServiceRuntime(
  env: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<GatewayServiceRuntime> {
  const unitName = `${resolveSystemdServiceName(env)}.service`;
  const budget =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  const deadline = performance.now() + budget;
  let remainingQueries = 7;
  const unavailable = () =>
    new Error("Loaded systemd runtime could not be inspected without activation.");
  const query = async (args: string[], signatures: string[]): Promise<unknown[]> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || remainingQueries <= 0) {
      throw unavailable();
    }
    const result = await execBusctlUser(
      env,
      ["--auto-start=no", "--json=short", ...args],
      Math.max(1, Math.floor(remaining / remainingQueries--)),
    );
    if (result.code !== 0 || result.termination !== "exit" || performance.now() >= deadline) {
      throw unavailable();
    }
    const values = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => asOptionalRecord(JSON.parse(line)));
    if (
      values.length !== signatures.length ||
      values.some((value, index) => value?.type !== signatures[index])
    ) {
      throw unavailable();
    }
    return values.map((value) => value?.data);
  };
  const readOwner = async () => {
    const [value] = await query(
      ["call", BUS, "/org/freedesktop/DBus", BUS, "GetNameOwner", "s", MANAGER],
      ["s"],
    );
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      typeof value[0] !== "string" ||
      !/^:[0-9]+\.[0-9]+$/.test(value[0])
    ) {
      throw unavailable();
    }
    return value[0];
  };
  try {
    // Address every unit query to the observed unique bus owner, never a newly started manager.
    const owner = await readOwner();
    const [credentials] = await query(
      ["call", BUS, "/org/freedesktop/DBus", BUS, "GetConnectionUnixUser", "s", owner],
      ["u"],
    );
    if (
      !Array.isArray(credentials) ||
      credentials.length !== 1 ||
      !isUint32(credentials[0]) ||
      credentials[0] === 0xffffffff
    ) {
      throw unavailable();
    }
    const managerUid = credentials[0];
    const [unit] = await query(
      ["call", owner, "/org/freedesktop/systemd1", `${MANAGER}.Manager`, "GetUnit", "s", unitName],
      ["o"],
    );
    if (
      !Array.isArray(unit) ||
      unit.length !== 1 ||
      typeof unit[0] !== "string" ||
      !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(unit[0])
    ) {
      throw unavailable();
    }
    const unitPath = unit[0];
    const readUnit = () =>
      query(
        [
          "get-property",
          owner,
          unitPath,
          `${MANAGER}.Unit`,
          "Id",
          "LoadState",
          "ActiveState",
          "SubState",
          "StartLimitBurst",
          "ActiveEnterTimestampMonotonic",
          "InactiveEnterTimestampMonotonic",
        ],
        ["s", "s", "s", "s", "u", "t", "t"],
      );
    const before = await readUnit();
    const [id, load, active, sub, burst, entered, left] = before;
    const [result, restarts, pid, exitStatus, exitCode, killMode, tasks, memory] = await query(
      [
        "get-property",
        owner,
        unitPath,
        `${MANAGER}.Service`,
        "Result",
        "NRestarts",
        "MainPID",
        "ExecMainStatus",
        "ExecMainCode",
        "KillMode",
        "TasksCurrent",
        "MemoryCurrent",
      ],
      ["s", "u", "u", "i", "i", "s", "t", "t"],
    );
    let drained = optionalCounter(tasks) === 0;
    if (
      (active === "inactive" || active === "failed") &&
      pid === 0 &&
      optionalCounter(tasks) === undefined
    ) {
      // TasksCurrent is UINT64_MAX when accounting is unavailable, not zero.
      // Ask the pinned manager for descendants and main/control PIDs instead.
      // This does not load a unit; failures remain unknown under the same deadline.
      remainingQueries++;
      const [processes] = await query(
        [
          "call",
          owner,
          "/org/freedesktop/systemd1",
          `${MANAGER}.Manager`,
          "GetUnitProcesses",
          "s",
          unitName,
        ],
        ["a(sus)"],
      );
      drained =
        Array.isArray(processes) &&
        processes.length === 1 &&
        Array.isArray(processes[0]) &&
        processes[0].length === 0;
    }
    // Same manager identity alone does not exclude unit restart/state changes.
    // Compare native transition generations as well as state to reject ABA observations.
    const after = await readUnit();
    if (
      !isDeepStrictEqual(before, after) ||
      optionalCounter(entered) === undefined ||
      optionalCounter(left) === undefined ||
      id !== unitName ||
      load !== "loaded" ||
      typeof active !== "string" ||
      typeof sub !== "string" ||
      !isUint32(burst) ||
      typeof result !== "string" ||
      !isUint32(restarts) ||
      !isUint32(pid) ||
      !isInt32(exitStatus) ||
      !isInt32(exitCode) ||
      typeof killMode !== "string" ||
      owner !== (await readOwner())
    ) {
      throw unavailable();
    }
    return {
      status:
        active === "active"
          ? "running"
          : (active === "inactive" || active === "failed") && pid === 0 && drained
            ? "stopped"
            : "unknown",
      state: active,
      subState: sub,
      pid: pid > 0 ? pid : undefined,
      lastExitStatus: exitStatus,
      lastExitReason: [undefined, "exited", "killed", "dumped", "trapped", "stopped", "continued"][
        exitCode
      ],
      systemd: {
        unit: id,
        managerUid,
        result,
        nRestarts: restarts,
        startLimitBurst: burst,
        killMode,
        tasksCurrent: optionalCounter(tasks),
        memoryCurrent: optionalCounter(memory),
      },
    };
  } catch (error) {
    return createServiceRuntimeInspectionFailure(error);
  }
}
