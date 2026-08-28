// System systemd ownership tests cover loaded, installed, and unverifiable states.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec-file.js";

const state = vi.hoisted(() => ({
  systemctl: {
    stdout: "not-found\n",
    stderr: "",
    code: 0,
    termination: "exit" as ExecResult["termination"],
  },
  managerUnitPath: {
    stdout:
      "/etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system\n",
    stderr: "",
    code: 0,
    termination: "exit" as ExecResult["termination"],
  },
  paths: new Set<string>(),
  pathErrors: new Map<string, string>(),
}));

function fsError(code: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${target}`), { code });
}

vi.mock("node:fs/promises", () => {
  const mocked = {
    lstat: vi.fn(async (target: string) => {
      const code = state.pathErrors.get(target);
      if (code) {
        throw fsError(code, target);
      }
      if (!state.paths.has(target)) {
        throw fsError("ENOENT", target);
      }
      return {};
    }),
  };
  return { ...mocked, default: mocked };
});

const execFileUtf8 = vi.hoisted(() =>
  vi.fn(
    async (
      _command: string,
      args: string[],
      _options?: { timeout?: number; killSignal?: string; env?: NodeJS.ProcessEnv },
    ) => (args.includes("--property=UnitPath") ? state.managerUnitPath : state.systemctl),
  ),
);
vi.mock("./exec-file.js", () => ({ execFileUtf8 }));

import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import { assertNoSystemSystemdOwnership } from "./systemd-system.js";

describe("system systemd ownership", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    vi.clearAllMocks();
    state.systemctl = { stdout: "not-found\n", stderr: "", code: 0, termination: "exit" };
    state.managerUnitPath = {
      stdout:
        "/etc/systemd/system /run/systemd/system /usr/local/lib/systemd/system /usr/lib/systemd/system\n",
      stderr: "",
      code: 0,
      termination: "exit",
    };
    state.paths.clear();
    state.pathErrors.clear();
    execFileUtf8.mockReset();
    execFileUtf8.mockImplementation(async (_command: string, args: string[]) =>
      args.includes("--property=UnitPath") ? state.managerUnitPath : state.systemctl,
    );
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", {
        ...originalPlatformDescriptor,
        value: "linux",
      });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("reports a unit loaded by the system manager", async () => {
    state.systemctl = { stdout: "loaded\n", stderr: "", code: 0, termination: "exit" };

    await expect(assertNoSystemSystemdOwnership("openclaw-gateway.service")).rejects.toMatchObject({
      ownership: { status: "loaded", unitName: "openclaw-gateway.service" },
    });
  });

  it.each([
    { ownership: "loaded", kind: "sealed" },
    { ownership: "installed", kind: "sealed" },
    { ownership: "unverifiable", kind: "unknown" },
    { ownership: "manager absent", kind: "unknown" },
    { ownership: "unexpected error", kind: "unknown" },
  ])(
    "fails closed for $ownership system ownership before user inspection",
    async ({ ownership, kind }) => {
      const unitName = "openclaw-owned.service";
      const systemUnitPath = `/etc/systemd/system/${unitName}`;
      state.systemctl = {
        code: ownership === "unverifiable" || ownership === "manager absent" ? 1 : 0,
        termination: "exit",
        stdout: ownership === "loaded" ? "loaded" : "not-found",
        stderr:
          ownership === "manager absent" ? "systemctl not available" : "manager-secret-canary",
      };
      if (ownership === "installed") {
        state.paths.add(systemUnitPath);
      } else if (ownership === "unexpected error") {
        execFileUtf8.mockRejectedValue(new Error("already owns manager-secret-canary"));
      }

      const capability = await readSystemdDefinitionMutationCapability({
        HOME: "/home/openclaw-test",
        OPENCLAW_STATE_DIR: "/state/openclaw-test",
        OPENCLAW_SYSTEMD_UNIT: unitName,
        OPENCLAW_SERVICE_KIND: "node",
      });

      expect(capability).toEqual({
        kind,
        detail: `System service ${unitName} requires its privileged deployment owner.`,
      });
      expect(JSON.stringify(capability)).not.toContain("manager-secret-canary");
      // Denial permits only system ownership probes, never user-manager or artifact reads.
      expect(execFileUtf8.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ["systemctl", ["show", "--property=LoadState", "--value", unitName]],
        ...(ownership === "installed"
          ? [["systemctl", ["show", "--property=UnitPath", "--value"]]]
          : []),
      ]);
      expect(vi.mocked(fs.lstat).mock.calls).toEqual(
        ownership === "installed" ? [[systemUnitPath]] : [],
      );
    },
  );

  it.each([
    "/etc/systemd/system/openclaw-gateway.service",
    "/run/systemd/system/openclaw-gateway.service",
    "/usr/local/lib/systemd/system/openclaw-gateway.service",
  ])("detects a custom same-name system unit at %s", async (unitPath) => {
    state.paths.add(unitPath);

    await expect(assertNoSystemSystemdOwnership("openclaw-gateway.service")).rejects.toMatchObject({
      ownership: {
        status: "installed",
        unitName: "openclaw-gateway.service",
        unitPath,
      },
    });
  });

  it("ignores differently named profile and custom units", async () => {
    state.paths.add("/etc/systemd/system/openclaw-gateway-rescue.service");
    state.paths.add("/etc/systemd/system/vendor-openclaw.service");

    await expect(
      assertNoSystemSystemdOwnership("openclaw-gateway-primary.service"),
    ).resolves.toBeUndefined();
    expect(execFileUtf8).toHaveBeenCalledTimes(3);
  });

  it("shares one timeout budget across system-manager ownership probes", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    execFileUtf8.mockImplementation(async (_command, args) => {
      now += 20;
      return args.includes("--property=UnitPath") ? state.managerUnitPath : state.systemctl;
    });
    try {
      await expect(
        assertNoSystemSystemdOwnership("openclaw-gateway.service", 50),
      ).resolves.toBeUndefined();
      expect(
        execFileUtf8.mock.calls.map((call) => ({
          timeout: call[2]?.timeout,
          killSignal: call[2]?.killSignal,
        })),
      ).toEqual([
        { timeout: 50, killSignal: "SIGKILL" },
        { timeout: 30, killSignal: "SIGKILL" },
        { timeout: 10, killSignal: "SIGKILL" },
      ]);
      expect(execFileUtf8.mock.calls.every((call) => call[2]?.env === process.env)).toBe(true);
      expect(execFileUtf8.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ["systemctl", ["show", "--property=LoadState", "--value", "openclaw-gateway.service"]],
        ["systemctl", ["show", "--property=UnitPath", "--value"]],
        ["systemctl", ["show", "--property=LoadState", "--value", "openclaw-gateway.service"]],
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    "Failed to connect to bus: Permission denied",
    "spawn systemctl ENOENT",
    "systemctl not available",
    "System has not been booted with systemd as init system",
    "Failed to connect to bus: No such file or directory",
  ])("fails closed when manager absence cannot be proven: %s", async (detail) => {
    state.systemctl = { stdout: "", stderr: detail, code: 1, termination: "exit" };

    await expect(assertNoSystemSystemdOwnership("openclaw-gateway.service")).rejects.toMatchObject({
      ownership: {
        status: "unverifiable",
        unitName: "openclaw-gateway.service",
        operation: "systemctl",
        detail,
      },
    });
    expect(fs.lstat).not.toHaveBeenCalled();
  });

  it.each(["exit", "timeout", "signal"] as const)(
    "accepts system-manager absence only after a completed query (%s)",
    async (termination) => {
      const detail = "Unit openclaw-gateway.service could not be found.";
      state.systemctl = { stdout: "", stderr: detail, code: 1, termination };

      const result = assertNoSystemSystemdOwnership("openclaw-gateway.service");
      if (termination === "exit") {
        await expect(result).resolves.toBeUndefined();
      } else {
        await expect(result).rejects.toMatchObject({
          ownership: { status: "unverifiable", operation: "systemctl", detail },
        });
      }
    },
  );

  it("fails closed when an exact system path cannot be inspected", async () => {
    const unitPath = "/etc/systemd/system/openclaw-gateway.service";
    state.pathErrors.set(unitPath, "EACCES");

    await expect(assertNoSystemSystemdOwnership("openclaw-gateway.service")).rejects.toMatchObject({
      ownership: {
        status: "unverifiable",
        unitName: "openclaw-gateway.service",
        operation: "filesystem",
        detail: `${unitPath}: EACCES: ${unitPath}`,
      },
    });
  });

  it("fails closed when manager unit load paths cannot be enumerated", async () => {
    state.managerUnitPath = {
      stdout: "",
      stderr: "manager UnitPath unavailable",
      code: 1,
      termination: "exit",
    };

    await expect(assertNoSystemSystemdOwnership("openclaw-gateway.service")).rejects.toMatchObject({
      ownership: {
        status: "unverifiable",
        operation: "systemctl",
        detail: "manager UnitPath unavailable",
      },
    });
  });

  it("rechecks the system manager after a negative filesystem snapshot", async () => {
    let systemctlCalls = 0;
    execFileUtf8.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("--property=UnitPath")) {
        return state.managerUnitPath;
      }
      systemctlCalls += 1;
      return systemctlCalls === 1
        ? { stdout: "not-found\n", stderr: "", code: 0, termination: "exit" }
        : { stdout: "loaded\n", stderr: "", code: 0, termination: "exit" };
    });

    await expect(assertNoSystemSystemdOwnership("openclaw-gateway.service")).rejects.toMatchObject({
      ownership: { status: "loaded", unitName: "openclaw-gateway.service" },
    });
  });

  it.each([
    { uid: 1000, prefix: "sudo " },
    { uid: 0, prefix: "" },
  ])("renders actionable ownership recovery for uid $uid", async ({ uid, prefix }) => {
    const existingGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
    Object.defineProperty(process, "geteuid", {
      configurable: true,
      value: () => uid,
    });
    state.paths.add("/etc/systemd/system/openclaw-gateway.service");

    try {
      const error = await assertNoSystemSystemdOwnership("openclaw-gateway.service").catch(
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({
        name: "SystemSystemdOwnershipError",
        code: "SYSTEM_SYSTEMD_OWNERSHIP",
        ownership: { status: "installed" },
      });
      expect(String(error)).toContain("--force does not override system ownership");
      expect(String(error)).toContain(`${prefix}systemctl disable --now openclaw-gateway.service`);
      expect(String(error)).toContain(`${prefix}rm /etc/systemd/system/openclaw-gateway.service`);
    } finally {
      if (existingGeteuid) {
        Object.defineProperty(process, "geteuid", existingGeteuid);
      } else {
        Reflect.deleteProperty(process, "geteuid");
      }
    }
  });

  it("does not recommend deleting package- or generator-owned units", async () => {
    state.paths.add("/usr/lib/systemd/system/openclaw-gateway.service");

    const error = await assertNoSystemSystemdOwnership("openclaw-gateway.service").catch(
      (caught: unknown) => caught,
    );

    expect(String(error)).toContain("uninstall or reconfigure the package, generator");
    expect(String(error)).not.toContain("rm /usr/lib/systemd/system/openclaw-gateway.service");
  });
});
