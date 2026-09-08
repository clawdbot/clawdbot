import { expect, vi } from "vitest";
import type { ExecResult } from "../../daemon/exec-file.js";
import type { GatewayServiceEnv, GatewayServiceReadOptions } from "../../daemon/service-types.js";
import * as systemd from "../../daemon/systemd-exec.js";
import { readSystemdServiceRuntime } from "../../daemon/systemd-runtime.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import * as admission from "./update-command-stopped-admission.js";

/** Emulate the wire contract, not the runtime summary. systemd v255 dbus.c
 * registers bus_unit_cgroup_vtable (GetProcesses) on Service, not Unit. */
export function useCollectedServiceRuntime() {
  // Exercise the full native protocol at the installed failure boundary. Other
  // recovery phases keep the existing service fixture, with their own controls.
  let admitting = false;
  let reads = 0;
  const claim = admission.claimStoppedServiceReplayAdmission;
  const entry = vi
    .spyOn(admission, "claimStoppedServiceReplayAdmission")
    .mockImplementation(async (params) => {
      admitting = true;
      try {
        await claim(params);
      } finally {
        admitting = false;
      }
    });
  vi.spyOn(systemd, "execBusctlUser").mockImplementation(async (env, args) => {
    const ok = (type: string, data: unknown): ExecResult => ({
      code: 0,
      termination: "exit",
      stdout: JSON.stringify({ type, data }),
      stderr: "",
    });
    const unit = `${resolveSystemdServiceName(env)}.service`;
    if (args.includes("GetNameOwner")) {
      return ok("s", [":1.42"]);
    }
    if (args.includes("GetConnectionUnixUser")) {
      return ok("u", [2001]);
    }
    if (args.includes("LoadUnit")) {
      return ok("o", ["/org/freedesktop/systemd1/unit/owned_2eservice"]);
    }
    if (args.includes("GetUnit")) {
      return { code: 1, termination: "exit", stdout: "", stderr: `Unit ${unit} not loaded` };
    }
    if (args.includes("GetProcesses")) {
      return args.includes("org.freedesktop.systemd1.Service")
        ? ok("a(sus)", [[]])
        : { code: 1, termination: "exit", stdout: "", stderr: "Unknown method GetProcesses" };
    }
    const properties: Record<string, [string, unknown]> = {
      Id: ["s", unit],
      LoadState: ["s", "loaded"],
      ActiveState: ["s", "inactive"],
      SubState: ["s", "dead"],
      StartLimitBurst: ["u", 5],
      ActiveEnterTimestampMonotonic: ["t", 0],
      InactiveEnterTimestampMonotonic: ["t", 0],
      Result: ["s", "success"],
      NRestarts: ["u", 0],
      MainPID: ["u", 0],
      ExecMainStatus: ["i", 0],
      ExecMainCode: ["i", 0],
      KillMode: ["s", "control-group"],
      TasksCurrent: ["t", Number("18446744073709551615")],
      MemoryCurrent: ["t", Number("18446744073709551615")],
    };
    const propertyIndex = args.findIndex((arg) => /\.(Unit|Service)$/.test(arg));
    if (!args.includes("get-property") || propertyIndex < 0) {
      throw new Error("Unexpected native read");
    }
    return {
      code: 0,
      termination: "exit",
      stderr: "",
      stdout: args
        .slice(propertyIndex + 1)
        .map((name) => {
          const [type, data] = properties[name]!;
          return JSON.stringify({ type, data });
        })
        .join("\n"),
    };
  });
  return {
    read: async (env: GatewayServiceEnv, options?: GatewayServiceReadOptions) => {
      if (!admitting) {
        return undefined;
      }
      reads++;
      return await readSystemdServiceRuntime(env, options);
    },
    verify: () => {
      expect(entry).toHaveBeenCalledOnce();
      // Each of the two observations closes its own native state/policy interval.
      expect(reads).toBeGreaterThanOrEqual(6);
    },
  };
}
