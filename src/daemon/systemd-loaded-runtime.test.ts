// Update runtime observation must not load units while discovering their state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec-file.js";

const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
const systemctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execSystemctlUser>());
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  execBusctlUser: busctl,
  execSystemctlUser: systemctl,
  assertSystemdAvailable: async () => {},
}));
vi.mock("./systemd-scope.js", () => ({ findInstalledSystemdGatewayScope: async () => null }));

import { readSystemdServiceRuntime } from "./systemd-runtime.js";

const env = {
  HOME: "/test/owned",
  OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
  OPENCLAW_PROFILE: "owned",
};
const unitName = "openclaw-owned.service";
const unitPath = "/org/freedesktop/systemd1/unit/openclaw_2downed_2eservice";
const properties = {
  Id: { type: "s", data: unitName },
  LoadState: { type: "s", data: "loaded" },
  ActiveState: { type: "s", data: "active" },
  SubState: { type: "s", data: "running" },
  StartLimitBurst: { type: "u", data: 5 },
  ActiveEnterTimestampMonotonic: { type: "t", data: 100 },
  InactiveEnterTimestampMonotonic: { type: "t", data: 0 },
  Result: { type: "s", data: "success" },
  NRestarts: { type: "u", data: 2 },
  MainPID: { type: "u", data: 412 },
  ExecMainStatus: { type: "i", data: 0 },
  ExecMainCode: { type: "i", data: 1 },
  KillMode: { type: "s", data: "control-group" },
  TasksCurrent: { type: "t", data: 8 },
  MemoryCurrent: { type: "t", data: 2048 },
};

function success(stdout: string): ExecResult {
  return { code: 0, termination: "exit", stdout, stderr: "" };
}
function managerReply(args: string[], overrides: Record<string, unknown> = {}): ExecResult {
  if (args.includes("GetNameOwner")) {
    return success(JSON.stringify({ type: "s", data: [":1.42"] }));
  }
  if (args.includes("GetConnectionUnixUser")) {
    return success(JSON.stringify({ type: "u", data: [2001] }));
  }
  if (args.includes("GetUnit")) {
    return success(JSON.stringify({ type: "o", data: [unitPath] }));
  }
  const propertyIndex = args.findIndex((arg) => /\.(Unit|Service)$/.test(arg));
  const values: Record<string, unknown> = { ...properties, ...overrides };
  if (propertyIndex < 0) {
    throw new Error(`Unexpected manager query: ${args.join(" ")}`);
  }
  return success(
    args
      .slice(propertyIndex + 1)
      .map((name) => JSON.stringify(values[name]))
      .join("\n"),
  );
}

beforeEach(() => {
  busctl.mockReset().mockImplementation(async (_env, args) => managerReply(args));
  systemctl
    .mockReset()
    .mockResolvedValue(success("Id=openclaw-owned.service\nLoadState=loaded\nActiveState=active"));
});

describe("loaded-only systemd runtime", () => {
  it("reads the owned loaded unit without systemctl show or unit activation", async () => {
    const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true, timeoutMs: 1000 });
    expect(runtime).toMatchObject({
      status: "running",
      pid: 412,
      state: "active",
      subState: "running",
      lastExitStatus: 0,
      lastExitReason: "exited",
      systemd: {
        unit: unitName,
        result: "success",
        nRestarts: 2,
        tasksCurrent: 8,
        memoryCurrent: 2048,
      },
    });
    expect(systemctl).not.toHaveBeenCalled();
    expect(
      busctl.mock.calls.every(
        ([selected, args]) =>
          selected === env && args.includes("--auto-start=no") && !args.includes("LoadUnit"),
      ),
    ).toBe(true);
    const pinned = busctl.mock.calls.filter(([, args]) => !args.includes("GetNameOwner"));
    expect(pinned).toHaveLength(5);
    expect(pinned.every(([, args]) => args.includes(":1.42"))).toBe(true);
  });

  it("uses the pinned bus owner's native UID instead of the updater account", async () => {
    const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true });
    expect(runtime.systemd).toMatchObject({ managerUid: 2001 });
    expect(
      busctl.mock.calls.some(
        ([, args]) => args.includes("GetConnectionUnixUser") && args.at(-1) === ":1.42",
      ),
    ).toBe(true);
  });

  it.each([[], [2001.5], [-1], 2001].map((uid) => ({ uid })))(
    "refuses an invalid manager UID reply $uid",
    async ({ uid }) => {
      busctl.mockImplementation(async (_env, args) =>
        args.includes("GetConnectionUnixUser")
          ? success(JSON.stringify({ type: "u", data: uid }))
          : managerReply(args),
      );
      await expect(readSystemdServiceRuntime(env, { requireLoaded: true })).resolves.toMatchObject({
        status: "unknown",
        inspectionFailure: expect.anything(),
      });
    },
  );

  it.each(["inactive", "failed", "activating", "deactivating", "reloading"])(
    "preserves terminal versus transitional state %s",
    async (state) => {
      busctl.mockImplementation(async (_env, args) =>
        managerReply(args, {
          ActiveState: { type: "s", data: state },
          SubState: { type: "s", data: state === "inactive" ? "dead" : state },
          MainPID: { type: "u", data: 0 },
          TasksCurrent: { type: "t", data: 0 },
        }),
      );
      expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe(
        state === "inactive" || state === "failed" ? "stopped" : "unknown",
      );
      expect(systemctl).not.toHaveBeenCalled();
    },
  );

  it("does not treat an unloaded unit as absent or load it to inspect it", async () => {
    busctl.mockImplementation(async (_env, args) =>
      args.includes("GetUnit")
        ? {
            code: 1,
            termination: "exit",
            stdout: "",
            stderr: `Call failed: Unit ${unitName} not loaded.`,
          }
        : managerReply(args),
    );
    const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true });
    expect(runtime.status).toBe("unknown");
    expect(runtime.missingUnit).not.toBe(true);
    expect(systemctl).not.toHaveBeenCalled();
  });

  it("refuses manager replacement during observation", async () => {
    let ownerReads = 0;
    busctl.mockImplementation(async (_env, args) =>
      args.includes("GetNameOwner") && ++ownerReads > 1
        ? success(JSON.stringify({ type: "s", data: [":1.43"] }))
        : managerReply(args),
    );
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  });

  it.each([
    { Id: { type: "s", data: "foreign.service" } },
    { LoadState: { type: "s", data: "not-found" } },
    { ActiveState: { type: "s", data: false } },
    { MainPID: { type: "u", data: -1 } },
  ])("refuses malformed or changed native identity %j", async (overrides) => {
    busctl.mockImplementation(async (_env, args) => managerReply(args, overrides));
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  });

  it("retains running observations when optional resource counters are unavailable", async () => {
    busctl.mockImplementation(async (_env, args) =>
      managerReply(args, {
        ActiveState: { type: "s", data: "active" },
        TasksCurrent: { type: "t", data: Number.MAX_SAFE_INTEGER + 1 },
        MemoryCurrent: { type: "t", data: Number.MAX_SAFE_INTEGER + 1 },
      }),
    );
    const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true });
    expect(runtime.status).toBe("running");
    expect(runtime.systemd?.tasksCurrent).toBeUndefined();
    expect(runtime.systemd?.memoryCurrent).toBeUndefined();
    expect(systemctl).not.toHaveBeenCalled();
  });

  it("bounds all manager calls by one monotonic deadline", async () => {
    let elapsed = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    busctl.mockImplementation(async (_env, args) => {
      elapsed += 90;
      return managerReply(args);
    });
    try {
      const runtime = await readSystemdServiceRuntime(env, { requireLoaded: true, timeoutMs: 500 });
      expect(runtime.status).toBe("unknown");
      expect(busctl).toHaveBeenCalledTimes(6);
      expect(busctl.mock.calls.map((call) => call[2])).toEqual([71, 68, 64, 57, 46, 25]);
      expect(systemctl).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { pid: 412, tasks: 0 },
    { pid: 0, tasks: 8 },
    { pid: 0, tasks: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses a stopped claim without drained native processes %j", async ({ pid, tasks }) => {
    busctl.mockImplementation(async (_env, args) =>
      managerReply(args, {
        ActiveState: { type: "s", data: "inactive" },
        SubState: { type: "s", data: "dead" },
        MainPID: { type: "u", data: pid },
        TasksCurrent: { type: "t", data: tasks },
      }),
    );
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  });

  it.each(["state", "generation"])(
    "refuses mixed runtime observation after a %s change",
    async (change) => {
      let serviceRead = false;
      busctl.mockImplementation(async (_env, args) => {
        if (args.includes("org.freedesktop.systemd1.Service")) {
          serviceRead = true;
        }
        return managerReply(args, {
          ActiveState: {
            type: "s",
            data: serviceRead && change === "state" ? "active" : "inactive",
          },
          SubState: { type: "s", data: "dead" },
          MainPID: { type: "u", data: 0 },
          TasksCurrent: { type: "t", data: 0 },
          ActiveEnterTimestampMonotonic: { type: "t", data: serviceRead ? 200 : 100 },
        });
      });
      expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe(
        "unknown",
      );
      expect(systemctl).not.toHaveBeenCalled();
    },
  );

  it("does not accept valid output after a query was terminated", async () => {
    busctl.mockImplementation(async (_env, args) => ({
      ...managerReply(args),
      termination: "timeout",
    }));
    expect((await readSystemdServiceRuntime(env, { requireLoaded: true })).status).toBe("unknown");
    expect(systemctl).not.toHaveBeenCalled();
  });
});
