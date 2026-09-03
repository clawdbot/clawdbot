import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// Systemd tests cover Linux service install, start, stop, and status behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { err as resultErr, ok } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGatewayInstallPlan } from "../commands/daemon-install-helpers.js";
import type { ExecResult } from "./exec-file.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput as serializeSystemdUnitProperties,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";

type ExecFileError = Error & {
  stderr?: string;
  code?: string | number;
  termination?: ExecResult["termination"];
};
type ExecFileCallback = (error: ExecFileError | null, stdout: string, stderr: string) => void;
type ExecFileMock = (
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => unknown;

const execFileMock = vi.hoisted(() => vi.fn<ExecFileMock>());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
const assertNoSystemSystemdOwnershipMock = vi.hoisted(() =>
  vi.fn<(unitName: string, timeoutMs?: number) => Promise<void>>(async () => {}),
);
const findSystemGatewayServicesMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Array<{
        platform: "linux";
        label: string;
        detail: string;
        scope: "user" | "system";
        marker?: "openclaw" | "clawdbot";
        legacy?: boolean;
      }>
    >
  >(async () => []),
);

vi.mock("./inspect.js", () => ({
  findSystemGatewayServices: () => findSystemGatewayServicesMock(),
}));

vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: (unitName: string, timeoutMs?: number) =>
    timeoutMs === undefined
      ? assertNoSystemSystemdOwnershipMock(unitName)
      : assertNoSystemSystemdOwnershipMock(unitName, timeoutMs),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
}));

vi.mock("./exec-file.js", () => {
  return {
    execFileUtf8: async (
      command: string,
      args: string[],
      options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
    ) => {
      let settled: ExecResult | undefined;

      execFileMock(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
        settled = {
          stdout: stdout ?? "",
          stderr: stderr || error?.message || "",
          code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          termination: error?.termination ?? (typeof error?.code === "string" ? "error" : "exit"),
          errorCode: typeof error?.code === "string" ? error.code : undefined,
        };
      });

      if (!settled) {
        throw new Error(`execFile mock did not settle for ${command} ${args.join(" ")}`);
      }
      return settled;
    },
  };
});

import { splitArgsPreservingQuotes } from "./arg-split.js";
import * as systemdExec from "./systemd-exec.js";
import { resolveSystemdUnitPath } from "./systemd-service-files.js";
import { parseSystemdEnvAssignments, parseSystemdExecStart } from "./systemd-unit.js";
import {
  findInstalledSystemdGatewayScope,
  findSystemdGatewayInstallation,
  formatDuelingScopesWarning,
  hasSudoToRootSystemdUserManagerMismatch,
  installSystemdService,
  isNonFatalSystemdInstallProbeError,
  isSystemdServiceEnabled,
  isSystemdUnitActive,
  isSystemdUserServiceAvailable,
  readSystemdServiceRuntime,
  readSystemdServiceExecStart,
  refreshLegacySystemdServiceMetadata,
  restartSystemdService,
  resolveSystemdUserServiceAccount,
  startSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallLegacySystemdUnits,
  uninstallSystemdService,
  isSystemUnitActiveAndEnabled,
  uninstallUserSystemdGatewayUnit,
} from "./systemd.js";

const TEST_SERVICE_HOME = "/home/test";
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";
const NODE_SERVICE = "openclaw-node.service";

const createExecFileError = (
  message: string,
  options: Pick<ExecFileError, "stderr" | "code" | "termination"> = {},
): ExecFileError => {
  const err = new Error(message) as ExecFileError;
  err.code = options.code ?? 1;
  err.termination = options.termination;
  if (options.stderr) {
    err.stderr = options.stderr;
  }
  return err;
};

const createWritableStreamMock = (write = vi.fn()) => {
  const stdout = { write };
  return {
    write,
    stdout: stdout as typeof stdout & NodeJS.WritableStream,
  };
};

type SystemdServiceFixture = Parameters<typeof stageSystemdService>[0];
type SystemdServiceFixtureOverrides = Omit<
  SystemdServiceFixture,
  "env" | "stdout" | "programArguments"
>;

function systemdServiceFixture(
  env: SystemdServiceFixture["env"],
  programArguments: string[],
  overrides: SystemdServiceFixtureOverrides = {},
): SystemdServiceFixture {
  return { env, stdout: createWritableStreamMock().stdout, programArguments, ...overrides };
}

function gatewaySystemdServiceFixture(
  env: SystemdServiceFixture["env"],
  overrides: Omit<SystemdServiceFixtureOverrides, "workingDirectory"> = {},
): SystemdServiceFixture {
  return systemdServiceFixture(env, ["/usr/bin/openclaw", "gateway", "run"], {
    workingDirectory: "/tmp",
    ...overrides,
  });
}

function nodeSystemdServiceFixture(
  env: SystemdServiceFixture["env"],
  overrides: Omit<SystemdServiceFixtureOverrides, "workingDirectory"> = {},
): SystemdServiceFixture {
  return systemdServiceFixture(env, ["/usr/bin/openclaw", "node", "run"], {
    workingDirectory: "/tmp",
    ...overrides,
  });
}

function gatewayPortSystemdServiceFixture(
  env: SystemdServiceFixture["env"],
  port: string,
): SystemdServiceFixture {
  return gatewaySystemdServiceFixture(env, { environment: { OPENCLAW_GATEWAY_PORT: port } });
}

function requireFirstWrite(write: ReturnType<typeof vi.fn>): string {
  const [call] = write.mock.calls;
  if (!call) {
    throw new Error("expected systemd status write");
  }
  const [value] = call;
  if (value === undefined) {
    throw new Error("expected systemd status write");
  }
  return String(value);
}

function pathLikeToString(pathname: unknown): string {
  if (typeof pathname === "string") {
    return pathname;
  }
  if (pathname instanceof URL) {
    return pathname.pathname;
  }
  if (pathname instanceof Uint8Array) {
    return Buffer.from(pathname).toString("utf8");
  }
  return "";
}

function assertUserSystemctlArgs(args: string[], ...command: string[]) {
  expect(args).toEqual(["--user", ...command]);
}

function assertMachineUserSystemctlArgs(args: string[], user: string, ...command: string[]) {
  expect(args).toEqual(["--machine", `${user}@`, "--user", ...command]);
}

function systemctlUserSuccess(...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertUserSystemctlArgs(args, ...command);
    cb(null, "", "");
  };
}

function systemctlMachineUserSuccess(user: string, ...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertMachineUserSystemctlArgs(args, user, ...command);
    cb(null, "", "");
  };
}

function execFileSuccess(): ExecFileMock {
  return (_cmd, _args, _opts, cb) => cb(null, "", "");
}

type ExecFileResult = [error: ExecFileError | null, stdout: string, stderr: string];

function systemctlUserResult(result: ExecFileResult, ...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertUserSystemctlArgs(args, ...command);
    cb(...result);
  };
}

function systemctlMachineUserResult(
  result: ExecFileResult,
  user: string,
  ...command: string[]
): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertMachineUserSystemctlArgs(args, user, ...command);
    cb(...result);
  };
}

function execFileResult(...result: ExecFileResult): ExecFileMock {
  return (_cmd, _args, _opts, cb) => cb(...result);
}

function mockNodeInstallNoMediumFailure(machineUser?: string): void {
  execFileMock
    .mockImplementationOnce(systemctlUserSuccess("status"))
    .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
    .mockImplementationOnce(
      systemctlUserResult(
        [
          createExecFileError("Failed to connect to bus: No medium found", {
            stderr: "Failed to connect to bus: No medium found",
          }),
          "",
          "",
        ],
        "enable",
        NODE_SERVICE,
      ),
    );
  if (machineUser) {
    execFileMock
      .mockImplementationOnce(systemctlMachineUserSuccess(machineUser, "enable", NODE_SERVICE))
      .mockImplementationOnce(systemctlUserSuccess("restart", NODE_SERVICE));
  }
}

function mockEffectiveUid(uid: number) {
  vi.spyOn(process, "geteuid").mockReturnValue(uid);
}

async function readManagedServiceEnabled(env: NodeJS.ProcessEnv = { HOME: TEST_MANAGED_HOME }) {
  vi.spyOn(fs, "access").mockResolvedValue(undefined);
  return isSystemdServiceEnabled({ env });
}

function mockReadGatewayServiceFile(
  unitLines: string[],
  extraFiles: Record<string, string | Error> = {},
) {
  return vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    const pathValue = pathLikeToString(pathname);
    if (pathValue.endsWith(`/${GATEWAY_SERVICE}`)) {
      return unitLines.join("\n");
    }
    const extraFile = extraFiles[pathValue];
    if (typeof extraFile === "string") {
      return extraFile;
    }
    if (extraFile instanceof Error) {
      throw extraFile;
    }
    throw new Error(`unexpected readFile path: ${pathValue}`);
  });
}

function buildSystemdUnitPropertyOutput(
  params: Pick<
    SystemdManagerSnapshotFixture,
    "fragmentPath" | "dropInPaths" | "needDaemonReload" | "loadState"
  >,
): string {
  return serializeSystemdUnitProperties({
    ...params,
    fragmentPath:
      params.fragmentPath ?? `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
  });
}

function mockSystemdManagerProperties(
  output: string | Error,
  unitOutput: string | Error = buildSystemdUnitPropertyOutput({}),
): void {
  vi.spyOn(systemdExec, "execBusctlUser").mockRestore();
  execFileMock.mockReset();
  execFileMock.mockImplementation((_command, args, _options, callback) => {
    const propertyOutput = args.includes("LoadUnit")
      ? JSON.stringify({
          type: "o",
          data: ["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"],
        })
      : args.includes("org.freedesktop.systemd1.Unit")
        ? unitOutput
        : output;
    if (propertyOutput instanceof Error) {
      callback(createExecFileError(propertyOutput.message), "", propertyOutput.message);
      return;
    }
    callback(null, propertyOutput, "");
  });
}

function mockSystemdManagerSnapshot(snapshot: SystemdManagerSnapshotFixture): void {
  mockSystemdManagerProperties(
    buildSystemdManagerPropertyOutput(snapshot),
    buildSystemdUnitPropertyOutput(snapshot),
  );
}

async function expectExecStartWithoutEnvironment(envFileLine: string) {
  mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run", envFileLine]);

  const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });
  expect(command?.programArguments).toEqual(["/usr/bin/openclaw", "gateway", "run"]);
  expect(command?.environment).toBeUndefined();
}

const assertRestartSuccess = async (env: NodeJS.ProcessEnv) => {
  const { write, stdout } = createWritableStreamMock();
  await restartSystemdService({ stdout, env });
  expect(write).toHaveBeenCalledTimes(1);
  expect(requireFirstWrite(write)).toContain("Restarted systemd service");
};

beforeEach(() => {
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});

describe("systemd availability", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns true when systemctl --user succeeds", async () => {
    execFileMock.mockImplementation(execFileResult(null, "", ""));
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("repairs missing user bus environment when the runtime bus exists", async () => {
    mockEffectiveUid(1000);
    existsSyncMock.mockReturnValue(true);
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      assertUserSystemctlArgs(args, "status");
      if (!opts.env) {
        throw new Error("expected systemctl env");
      }
      expect(opts.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
      expect(opts.env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
      cb(null, "", "");
    });

    await expect(
      isSystemdUserServiceAvailable({
        USER: "debian",
        XDG_RUNTIME_DIR: undefined,
        DBUS_SESSION_BUS_ADDRESS: undefined,
      }),
    ).resolves.toBe(true);
  });

  it("returns false when systemd user bus is unavailable", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("Failed to connect to bus") as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = "Failed to connect to bus";
      err.code = 1;
      cb(err, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(false);
  });

  it("returns true when systemd is degraded but still reachable", async () => {
    execFileMock.mockImplementation(
      execFileResult(
        createExecFileError("degraded", { stderr: "degraded\nsome-unit.service failed" }),
        "",
        "",
      ),
    );

    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("falls back to machine user scope when --user bus is unavailable", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "status"]);
        const err = createExecFileError("Failed to connect to user scope bus via local transport", {
          stderr:
            "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--machine", "debian@", "--user", "status"]);
        cb(null, "", "");
      });

    await expect(isSystemdUserServiceAvailable({ USER: "debian" })).resolves.toBe(true);
  });

  it("does not fall back to machine scope when --user fails with permission denied", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["--user", "status"]);
      cb(
        createExecFileError("Failed to connect to bus: Permission denied", {
          stderr: "Failed to connect to bus: Permission denied",
          code: 1,
        }),
        "",
        "",
      );
    });
    // Only one call should be made: no machine-scope fallback for permission denied errors.
    await expect(isSystemdUserServiceAvailable({ USER: "debian" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to direct --user when machine scope fails under sudo", async () => {
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce(
      systemctlMachineUserResult(
        [
          createExecFileError("Failed to connect to bus: No such file or directory", {
            stderr: "Failed to connect to bus: No such file or directory",
            code: 1,
          }),
          "",
          "",
        ],
        "ai",
        "status",
      ),
    );

    await expect(isSystemdUserServiceAvailable({ SUDO_USER: "ai" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not let preserved USER suppress sudo-to-root machine scope", async () => {
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce(systemctlMachineUserSuccess("debian", "status"));

    await expect(
      isSystemdUserServiceAvailable({
        SUDO_USER: "debian",
        USER: "root-env-stale",
        LOGNAME: "root-env-stale",
      }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the sudo caller as the systemd user service account", () => {
    mockEffectiveUid(0);
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "root",
      uid: 0,
      gid: 0,
      shell: "/bin/bash",
      homedir: "/root",
    });

    const env = { SUDO_USER: "debian", USER: "root", LOGNAME: "root" };
    expect(resolveSystemdUserServiceAccount(env)).toBe("debian");
    expect(hasSudoToRootSystemdUserManagerMismatch(env)).toBe(true);
  });

  it("keeps root user scope when stale SUDO_USER is paired with root bus environment", async () => {
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce(systemctlUserSuccess("status"));

    await expect(
      isSystemdUserServiceAvailable({
        HOME: "/root",
        USER: "root",
        LOGNAME: "root",
        SUDO_USER: "debian",
        XDG_RUNTIME_DIR: "/run/user/0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
      }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves root for a real root user-manager environment", () => {
    mockEffectiveUid(0);
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "root",
      uid: 0,
      gid: 0,
      shell: "/bin/bash",
      homedir: "/root",
    });

    const env = {
      HOME: "/root",
      USER: "root",
      LOGNAME: "root",
      SUDO_USER: "debian",
      XDG_RUNTIME_DIR: "/run/user/0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
    };
    expect(resolveSystemdUserServiceAccount(env)).toBe("root");
    expect(hasSudoToRootSystemdUserManagerMismatch(env)).toBe(false);
  });

  it("does not let stale SUDO_USER override a sudo-u target user scope", async () => {
    mockEffectiveUid(1000);
    execFileMock.mockImplementationOnce(systemctlUserSuccess("status"));

    await expect(
      isSystemdUserServiceAvailable({ USER: "openclaw", SUDO_USER: "admin" }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("resolves the effective non-root account instead of stale SUDO_USER", () => {
    mockEffectiveUid(1000);
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "openclaw",
      uid: 1000,
      gid: 1000,
      shell: "/bin/bash",
      homedir: "/home/openclaw",
    });

    expect(resolveSystemdUserServiceAccount({ USER: "openclaw", SUDO_USER: "admin" })).toBe(
      "openclaw",
    );
  });
});

describe("isSystemdServiceEnabled", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("throws when systemctl is not present", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("spawn systemctl EACCES") as Error & { code?: string };
      err.code = "EACCES";
      cb(err, "", "");
    });
    await expect(readManagedServiceEnabled()).rejects.toThrow(
      "systemctl is-enabled unavailable: spawn systemctl EACCES",
    );
  });

  it("returns false without calling systemctl when the managed unit file is missing", async () => {
    const err = new Error("missing unit") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    vi.spyOn(fs, "access").mockRejectedValueOnce(err);

    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });

    expect(result).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("calls systemctl is-enabled when systemctl is present", async () => {
    execFileMock.mockImplementationOnce(
      systemctlUserResult([null, "enabled", ""], "is-enabled", GATEWAY_SERVICE),
    );
    const result = await readManagedServiceEnabled();
    expect(result).toBe(true);
  });

  it.each(["exit", "timeout", "signal"] as const)(
    "accepts disabled output only after a completed is-enabled command (%s)",
    async (termination) => {
      execFileMock.mockImplementationOnce(
        systemctlUserResult(
          [createExecFileError("disabled", { termination }), "disabled", ""],
          "is-enabled",
          GATEWAY_SERVICE,
        ),
      );

      const result = readManagedServiceEnabled();
      if (termination === "exit") {
        await expect(result).resolves.toBe(false);
      } else {
        await expect(result).rejects.toThrow("systemctl is-enabled unavailable:");
      }
    },
  );

  it("returns false for the WSL2 Ubuntu 24.04 wrapper-only is-enabled failure", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      const err = new Error(
        `Command failed: systemctl --user is-enabled ${GATEWAY_SERVICE}`,
      ) as Error & { code?: number };
      err.code = 1;
      cb(err, "", "");
    });

    await expect(readManagedServiceEnabled()).rejects.toThrow(
      `systemctl is-enabled unavailable: Command failed: systemctl --user is-enabled ${GATEWAY_SERVICE}`,
    );
  });

  it("returns false when is-enabled cannot connect to the user bus without machine fallback", async () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockImplementationOnce(
      systemctlUserResult(
        [
          createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
          "",
          "",
        ],
        "is-enabled",
        GATEWAY_SERVICE,
      ),
    );

    await expect(
      readManagedServiceEnabled({ HOME: TEST_MANAGED_HOME, USER: "", LOGNAME: "" }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to bus");
  });

  it("returns false when both direct and machine-scope is-enabled checks report bus unavailability", async () => {
    execFileMock
      .mockImplementationOnce(
        systemctlUserResult(
          [
            createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
            "",
            "",
          ],
          "is-enabled",
          GATEWAY_SERVICE,
        ),
      )
      .mockImplementationOnce(
        systemctlMachineUserResult(
          [
            createExecFileError("Failed to connect to user scope bus via local transport", {
              stderr:
                "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
            }),
            "",
            "",
          ],
          "debian",
          "is-enabled",
          GATEWAY_SERVICE,
        ),
      );

    await expect(
      readManagedServiceEnabled({ HOME: TEST_MANAGED_HOME, USER: "debian" }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to user scope bus");
  });

  it("throws when generic wrapper errors report infrastructure failures", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      const err = new Error(
        `Command failed: systemctl --user is-enabled ${GATEWAY_SERVICE}`,
      ) as Error & { code?: number };
      err.code = 1;
      cb(err, "", "read-only file system");
    });

    await expect(readManagedServiceEnabled()).rejects.toThrow(
      "systemctl is-enabled unavailable: read-only file system",
    );
  });

  it("throws when systemctl is-enabled fails for non-state errors", async () => {
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        const err = new Error("Failed to connect to bus") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "Failed to connect to bus");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args[0]).toBe("--machine");
        expect(args[1]).toMatch(/^[^@]+@$/);
        expect(args.slice(2)).toEqual(["--user", "is-enabled", "openclaw-gateway.service"]);
        const err = new Error("permission denied") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });
    await expect(
      isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } }),
    ).rejects.toThrow("systemctl is-enabled unavailable: permission denied");
  });

  it("returns false when systemctl is-enabled exits with code 4 (not-found)", async () => {
    vi.spyOn(fs, "access").mockResolvedValue(undefined);
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      // On Ubuntu 24.04, `systemctl --user is-enabled <unit>` exits with
      // code 4 and prints "not-found" to stdout when the unit doesn't exist.
      const err = new Error(
        "Command failed: systemctl --user is-enabled openclaw-gateway.service",
      ) as Error & { code?: number };
      err.code = 4;
      cb(err, "not-found\n", "");
    });
    const result = await isSystemdServiceEnabled({ env: { HOME: "/tmp/openclaw-test-home" } });
    expect(result).toBe(false);
  });
});

describe("isSystemdUnitActive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
  });

  describe.each(["user", "system"] as const)("%s activity queries", (scope) => {
    it.each([
      ["bus failure", { code: 1 }, "Failed to connect to bus: Permission denied"],
      ["unexpected exit", { code: 2 }, "Unexpected query failure"],
      ["launch error", { code: "ENOENT" }, "Command failed during launch (ENOENT)"],
      ["signal", { code: 1, termination: "signal" }, "Command was terminated by SIGTERM"],
      ["timeout", { code: 3, termination: "timeout" }, "Command timed out"],
    ] satisfies [string, Pick<ExecFileError, "code" | "termination">, string][])(
      "keeps failed activity probes distinguishable from inactive units: %s",
      async (_, options, detail) => {
        execFileMock.mockImplementation(
          execFileResult(createExecFileError(detail, options), "", detail),
        );

        await expect(
          isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE, scope),
        ).resolves.toEqual(resultErr(detail));
      },
    );
  });

  it("checks user-scoped units through the user systemd manager", async () => {
    execFileMock.mockImplementationOnce(
      systemctlUserSuccess("is-active", "--quiet", GATEWAY_SERVICE),
    );

    await expect(
      isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE),
    ).resolves.toEqual(ok(true));
  });

  it.each([3, 4])("recognizes non-active system-scoped units (exit %i)", async (code) => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
      cb(createExecFileError("not active", { code }), "", "");
    });

    await expect(
      isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE, "system"),
    ).resolves.toEqual(ok(false));
  });
});

describe("system-scope gateway unit detection (openclaw#87577)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockUnitFileLayout(layout: { user?: boolean; system?: string | false }) {
    vi.spyOn(fs, "access").mockImplementation(async (pathArg) => {
      const p = pathLikeToString(pathArg);
      if (layout.user && p.includes("/.config/systemd/user/")) {
        return undefined;
      }
      if (typeof layout.system === "string" && p === layout.system) {
        return undefined;
      }
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  }

  it("findInstalledSystemdGatewayScope prefers user scope when both exist", async () => {
    // Lifecycle callers keep the long-standing user-first preference; dueling
    // resolution is handled separately by doctor (issue #79375).
    mockUnitFileLayout({
      user: true,
      system: "/etc/systemd/system/openclaw-gateway.service",
    });
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result?.scope).toBe("user");
    expect(result?.unitName).toBe(GATEWAY_SERVICE);
    expect(result?.unitPath).toContain("/.config/systemd/user/openclaw-gateway.service");
  });

  it("findSystemdGatewayInstallation reports the dueling state when both units exist", async () => {
    mockUnitFileLayout({
      user: true,
      system: "/etc/systemd/system/openclaw-gateway.service",
    });
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
    expect(installation.kind).toBe("dueling");
    if (installation.kind !== "dueling") {
      throw new Error("expected dueling installation");
    }
    expect(installation.user.scope).toBe("user");
    expect(installation.user.unitPath).toContain("/.config/systemd/user/openclaw-gateway.service");
    expect(installation.system).toEqual({
      scope: "system",
      unitName: GATEWAY_SERVICE,
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
  });

  it("findSystemdGatewayInstallation reports user-only", async () => {
    mockUnitFileLayout({ user: true, system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([]);
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
    expect(installation.kind).toBe("user");
  });

  it("findSystemdGatewayInstallation reports system-only", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
    expect(installation.kind).toBe("system");
  });

  it("does not treat a custom marker-owned system gateway as dueling with the user unit", async () => {
    // An intentional separate gateway (e.g. a rescue bot) under a different
    // unit name must NOT be classified as a duplicate of the canonical user
    // unit, or doctor could remove a legitimate user gateway (issue #79375 P1).
    mockUnitFileLayout({ user: true, system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-rescue.service",
        detail: "unit: /etc/systemd/system/openclaw-rescue.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
    expect(installation.kind).toBe("user");
  });

  it("findSystemdGatewayInstallation reports none when nothing is installed", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([]);
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
    expect(installation.kind).toBe("none");
  });

  it("formatDuelingScopesWarning renders remediation only for the dueling state", async () => {
    mockUnitFileLayout({
      user: true,
      system: "/etc/systemd/system/openclaw-gateway.service",
    });
    const installation = await findSystemdGatewayInstallation({ HOME: TEST_MANAGED_HOME });
    const warning = formatDuelingScopesWarning(installation, 18789);
    expect(warning).toContain("/.config/systemd/user/openclaw-gateway.service");
    expect(warning).toContain("/etc/systemd/system/openclaw-gateway.service");
    expect(warning).toContain("18789");
    expect(warning).toContain("openclaw doctor --fix");
    // The unguarded startup path must not hand out a destructive command.
    expect(warning).not.toContain("rm ");
    expect(warning).not.toContain("disable --now");
  });

  it("formatDuelingScopesWarning returns null for single-scope installs", () => {
    expect(formatDuelingScopesWarning({ kind: "none" }, 18789)).toBeNull();
    expect(
      formatDuelingScopesWarning(
        {
          kind: "system",
          system: {
            scope: "system",
            unitName: GATEWAY_SERVICE,
            unitPath: "/etc/systemd/system/openclaw-gateway.service",
          },
        },
        18789,
      ),
    ).toBeNull();
  });

  it("findInstalledSystemdGatewayScope detects system-scope unit in /etc/systemd/system", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "system",
      unitName: GATEWAY_SERVICE,
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
  });

  it("findInstalledSystemdGatewayScope falls back to /usr/lib/systemd/system", async () => {
    mockUnitFileLayout({ system: "/usr/lib/systemd/system/openclaw-gateway.service" });
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result?.scope).toBe("system");
    expect(result?.unitPath).toBe("/usr/lib/systemd/system/openclaw-gateway.service");
  });

  it("findInstalledSystemdGatewayScope returns null when no unit file exists", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope falls back to marker-owned system unit with custom name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw.service",
      unitPath: "/etc/systemd/system/openclaw.service",
    });
  });

  it("findInstalledSystemdGatewayScope ignores legacy clawdbot system units in the marker fallback", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "clawdbot.service",
        detail: "unit: /etc/systemd/system/clawdbot.service",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toBeNull();
  });

  it("isSystemdServiceEnabled queries the marker-owned custom system unit name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", "openclaw.service"]);
      cb(null, "enabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(true);
  });

  it("restartSystemdService surfaces sudo guidance using the marker-owned custom unit name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    mockEffectiveUid(1000);
    const { stdout, write } = createWritableStreamMock();
    await expect(
      restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } }),
    ).rejects.toThrow(
      /openclaw\.service is a system-scope unit \(\/etc\/systemd\/system\/openclaw\.service\); run `sudo systemctl restart openclaw\.service`/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("isSystemdServiceEnabled reports true for an enabled system-scope unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
      cb(null, "enabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(true);
  });

  it("isSystemdServiceEnabled reports false for a disabled system-scope unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
      cb(createExecFileError("disabled", { code: 1 }), "disabled\n", "");
    });
    await expect(isSystemdServiceEnabled({ env: { HOME: TEST_MANAGED_HOME } })).resolves.toBe(
      false,
    );
  });

  it("readSystemdServiceRuntime queries the system manager for system-scope units", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args[0]).toBe("show");
      expect(args).not.toContain("--user");
      cb(
        null,
        [
          "Id=openclaw-gateway.service",
          "ActiveState=active",
          "SubState=running",
          "MainPID=4242",
        ].join("\n"),
        "",
      );
    });
    const runtime = await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    expect(runtime.status).toBe("running");
    expect(runtime.pid).toBe(4242);
    expect(runtime.systemd?.unit).toBe("openclaw-gateway.service");
  });

  it("restartSystemdService refuses to use the user manager when the unit is system-scope and the caller is not root", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(1000);
    const { stdout, write } = createWritableStreamMock();
    await expect(
      restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } }),
    ).rejects.toThrow(
      /system-scope unit .* run `sudo systemctl restart openclaw-gateway\.service`/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("restartSystemdService restarts the system unit directly when running as root", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(0);
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["reset-failed", GATEWAY_SERVICE]);
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["restart", GATEWAY_SERVICE]);
        cb(null, "", "");
      });
    const { stdout, write } = createWritableStreamMock();
    const result = await restartSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } });
    expect(result).toEqual({ outcome: "completed" });
    expect(requireFirstWrite(write)).toContain("Restarted systemd service");
  });

  it("startSystemdService clears the start-limit latch before starting the system unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(0);
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["reset-failed", GATEWAY_SERVICE]);
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["start", GATEWAY_SERVICE]);
        cb(null, "", "");
      });
    const { stdout, write } = createWritableStreamMock();
    await startSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } });
    expect(requireFirstWrite(write)).toContain("Started systemd service");
  });

  it("stopSystemdService surfaces sudo guidance for system-scope units without root", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-gateway.service" });
    mockEffectiveUid(1000);
    const { stdout } = createWritableStreamMock();
    await expect(stopSystemdService({ stdout, env: { HOME: TEST_MANAGED_HOME } })).rejects.toThrow(
      /sudo systemctl stop openclaw-gateway\.service/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("isNonFatalSystemdInstallProbeError", () => {
  it("matches wrapper-only WSL install probe failures", () => {
    expect(
      isNonFatalSystemdInstallProbeError(
        new Error("Command failed: systemctl --user is-enabled openclaw-gateway.service"),
      ),
    ).toBe(true);
  });

  it("matches bus-unavailable install probe failures", () => {
    expect(
      isNonFatalSystemdInstallProbeError(
        new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
      ),
    ).toBe(true);
  });

  it("does not match real infrastructure failures", () => {
    expect(
      isNonFatalSystemdInstallProbeError(
        new Error("systemctl is-enabled unavailable: read-only file system"),
      ),
    ).toBe(false);
  });
});

describe("readSystemdServiceRuntime", () => {
  async function readRuntimeFromShowOutput(output: string) {
    execFileMock.mockReset();
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args[0]).toBe("--user");
        expect(args[1]).toBe("show");
        cb(null, output, "");
      });
    return await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
  }

  it("parses active state details", async () => {
    const runtime = await readRuntimeFromShowOutput(
      [
        "ActiveState=inactive",
        "SubState=dead",
        "MainPID=0",
        "ExecMainStatus=2",
        "ExecMainCode=exited",
      ].join("\n"),
    );
    expect(runtime).toMatchObject({
      status: "stopped",
      state: "inactive",
      subState: "dead",
      lastExitStatus: 2,
      lastExitReason: "exited",
    });
  });

  it.each([
    ["activating", "auto-restart"],
    ["deactivating", "stop-sigterm"],
    ["reloading", "reload"],
  ])("does not report %s/%s as a stopped service", async (state, subState) => {
    const runtime = await readRuntimeFromShowOutput(
      `ActiveState=${state}\nSubState=${subState}\nMainPID=0`,
    );
    expect(runtime).toMatchObject({ status: "unknown", state, subState });
  });

  it.each([
    { loadState: "not-found", activeState: "inactive", missing: true, status: "stopped" },
    { loadState: "loaded", activeState: "inactive", missing: false, status: "stopped" },
    { loadState: "not-found", activeState: "active", missing: false, status: "running" },
  ])(
    "records native unit absence from a successful show ($loadState/$activeState)",
    async ({ loadState, activeState, missing, status }) => {
      const runtime = await readRuntimeFromShowOutput(
        `LoadState=${loadState}\nActiveState=${activeState}\nSubState=${status === "running" ? "running" : "dead"}\nMainPID=0`,
      );
      expect(runtime.status).toBe(status);
      expect(runtime.missingUnit === true).toBe(missing);
    },
  );

  it.each(["exit", "timeout", "signal"] as const)(
    "reports a missing unit only after a completed show command (%s)",
    async (termination) => {
      const detail = "Unit openclaw-gateway.service could not be found.";
      const accessSpy = vi
        .spyOn(fs, "access")
        .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce((_cmd, _args, _opts, cb) => {
          cb(createExecFileError(detail, { termination }), "", detail);
        });

      try {
        await expect(readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME })).resolves.toEqual(
          termination === "exit"
            ? { status: "stopped", missingUnit: true }
            : { status: "unknown", missingUnit: false, detail },
        );
      } finally {
        accessSpy.mockRestore();
      }
    },
  );

  it("keeps unexpected systemctl failures visible", async () => {
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        const detail = "Permission denied while reading systemd state";
        cb(createExecFileError(detail, { stderr: detail }), "", detail);
      });

    await expect(readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME })).resolves.toEqual({
      status: "unknown",
      detail: "Permission denied while reading systemd state",
      missingUnit: false,
    });
  });

  it.each(["error", "not-found"])(
    "does not call an installed unit missing when systemd disagrees with its definition (%s)",
    async (result) => {
      const accessSpy = vi.spyOn(fs, "access").mockImplementation(async (pathArg) => {
        if (pathLikeToString(pathArg) === "/etc/systemd/system/openclaw-gateway.service") {
          return;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        if (result === "not-found") {
          cb(null, "LoadState=not-found\nActiveState=inactive\nSubState=dead", "");
          return;
        }
        const detail = "Unit openclaw-gateway.service could not be found.";
        cb(createExecFileError(detail, { stderr: detail }), "", detail);
      });

      try {
        await expect(readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME })).resolves.toMatchObject(
          {
            status: result === "error" ? "unknown" : "stopped",
            ...(result === "error"
              ? { detail: "Unit openclaw-gateway.service could not be found." }
              : {}),
            missingUnit: false,
          },
        );
      } finally {
        accessSpy.mockRestore();
      }
    },
  );

  it("parses Result and the restart counter for crash-loop give-up detection", async () => {
    // Real systemd 249 give-up shape: a crash-looped unit keeps Result=exit-code
    // (start-limit-hit never overwrites an exec failure), so the counter reaching
    // StartLimitBurst is what flags the give-up.
    const runtime = await readRuntimeFromShowOutput(
      [
        "ActiveState=failed",
        "SubState=failed",
        "Result=exit-code",
        "NRestarts=5",
        "StartLimitBurst=5",
        "MainPID=0",
        "ExecMainStatus=1",
        "ExecMainCode=exited",
      ].join("\n"),
    );
    expect(runtime).toMatchObject({
      status: "stopped",
      state: "failed",
      subState: "failed",
      lastExitStatus: 1,
      lastExitReason: "exited",
      systemd: { result: "exit-code", nRestarts: 5, startLimitBurst: 5 },
    });
  });

  it("rejects pid and exit status values with junk suffixes", async () => {
    const runtime = await readRuntimeFromShowOutput(
      [
        "ActiveState=inactive",
        "SubState=dead",
        "MainPID=42abc",
        "ExecMainStatus=2ms",
        "ExecMainCode=exited",
      ].join("\n"),
    );
    expect(runtime.pid).toBeUndefined();
    expect(runtime.lastExitStatus).toBeUndefined();
    expect(runtime.lastExitReason).toBe("exited");
  });

  it("rejects invalid cgroup counters as junk", async () => {
    const runtime = await readRuntimeFromShowOutput(
      [
        "ActiveState=active",
        "SubState=running",
        "MainPID=1",
        "ExecMainStatus=0",
        "ExecMainCode=running",
        "KillMode=process",
        "TasksCurrent=42abc",
        "MemoryCurrent=11GB",
      ].join("\n"),
    );
    expect(runtime).toMatchObject({
      status: "running",
      pid: 1,
      lastExitStatus: 0,
      lastExitReason: "running",
      systemd: { killMode: "process" },
    });
    expect(runtime.systemd?.tasksCurrent).toBeUndefined();
    expect(runtime.systemd?.memoryCurrent).toBeUndefined();
  });

  it("surfaces systemd cgroup metrics and KillMode", async () => {
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(
        systemctlUserResult(
          [
            null,
            [
              "Id=openclaw-gateway.service",
              "ActiveState=active",
              "SubState=running",
              "MainPID=1234",
              "ExecMainStatus=0",
              "ExecMainCode=running",
              "KillMode=process",
              "TasksCurrent=807",
              "MemoryCurrent=11918534246",
            ].join("\n"),
            "",
          ],
          "show",
          GATEWAY_SERVICE,
          "--no-page",
          "--property",
          "Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
        ),
      );
    const runtime = await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    expect(runtime).toEqual({
      status: "running",
      state: "active",
      subState: "running",
      pid: 1234,
      lastExitStatus: 0,
      lastExitReason: "running",
      systemd: {
        unit: "openclaw-gateway.service",
        killMode: "process",
        tasksCurrent: 807,
        memoryCurrent: 11_918_534_246,
      },
    });
  });

  // Regression for #84698: status probes must bound the systemctl subprocess so a
  // wedged systemd socket cannot hang `openclaw status` (which advertises --timeout).
  it("passes a kill-backed timeout to systemctl when a read deadline is set", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation(execFileResult(null, "", ""));
    await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME }, { timeoutMs: 1234 });
    expect(execFileMock).toHaveBeenCalled();
    for (const call of execFileMock.mock.calls) {
      const opts = call[2] as { timeout?: number; killSignal?: string };
      expect(opts.timeout).toBe(1234);
      expect(opts.killSignal).toBe("SIGKILL");
    }
  });

  it("leaves systemctl unbounded when no read deadline is set", async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation(execFileResult(null, "", ""));
    await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    expect(execFileMock).toHaveBeenCalled();
    for (const call of execFileMock.mock.calls) {
      const opts = call[2] as { timeout?: number; killSignal?: string };
      expect(opts.timeout).toBeUndefined();
      expect(opts.killSignal).toBeUndefined();
    }
  });

  it("carries the supervision counters through a crash-looped failed unit", async () => {
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(
        execFileResult(
          null,
          [
            "Id=openclaw-gateway.service",
            "ActiveState=failed",
            "SubState=failed",
            "Result=exit-code",
            "NRestarts=5",
            "StartLimitBurst=5",
            "MainPID=0",
            "ExecMainStatus=1",
            "ExecMainCode=exited",
          ].join("\n"),
          "",
        ),
      );
    const runtime = await readSystemdServiceRuntime({ HOME: TEST_MANAGED_HOME });
    // ActiveState=failed collapses to the generic "stopped" status, so the raw
    // state + restart counters are what let callers detect the crash-loop give-up.
    expect(runtime.status).toBe("stopped");
    expect(runtime.state).toBe("failed");
    expect(runtime.systemd).toMatchObject({
      result: "exit-code",
      nRestarts: 5,
      startLimitBurst: 5,
    });
  });
});

describe("resolveSystemdUnitPath", () => {
  it.each([
    {
      name: "uses default service name when OPENCLAW_PROFILE is unset",
      env: { HOME: "/home/test" },
      expected: "/home/test/.config/systemd/user/openclaw-gateway.service",
    },
    {
      name: "uses profile-specific service name when OPENCLAW_PROFILE is set to a custom value",
      env: { HOME: "/home/test", OPENCLAW_PROFILE: "jbphoenix" },
      expected: "/home/test/.config/systemd/user/openclaw-gateway-jbphoenix.service",
    },
    {
      name: "prefers OPENCLAW_SYSTEMD_UNIT over OPENCLAW_PROFILE",
      env: {
        HOME: "/home/test",
        OPENCLAW_PROFILE: "jbphoenix",
        OPENCLAW_SYSTEMD_UNIT: "custom-unit",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
    {
      name: "handles OPENCLAW_SYSTEMD_UNIT with .service suffix",
      env: {
        HOME: "/home/test",
        OPENCLAW_SYSTEMD_UNIT: "custom-unit.service",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
    {
      name: "trims whitespace from OPENCLAW_SYSTEMD_UNIT",
      env: {
        HOME: "/home/test",
        OPENCLAW_SYSTEMD_UNIT: "  custom-unit  ",
      },
      expected: "/home/test/.config/systemd/user/custom-unit.service",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveSystemdUnitPath(env)).toBe(expected);
  });
});

describe("splitArgsPreservingQuotes", () => {
  it("splits on whitespace outside quotes", () => {
    expect(splitArgsPreservingQuotes('/usr/bin/openclaw gateway start --name "My Bot"')).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("supports systemd-style backslash escaping", () => {
    expect(
      splitArgsPreservingQuotes('openclaw --name "My \\"Bot\\"" --foo bar', {
        escapeMode: "backslash",
      }),
    ).toEqual(["openclaw", "--name", 'My "Bot"', "--foo", "bar"]);
  });

  it("supports schtasks-style escaped quotes while preserving other backslashes", () => {
    expect(
      splitArgsPreservingQuotes('openclaw --path "C:\\\\Program Files\\\\OpenClaw"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["openclaw", "--path", "C:\\\\Program Files\\\\OpenClaw"]);

    expect(
      splitArgsPreservingQuotes('openclaw --label "My \\"Quoted\\" Name"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["openclaw", "--label", 'My "Quoted" Name']);
  });
});

describe("parseSystemdEnvAssignments", () => {
  it("parses single-quoted whole assignments", () => {
    expect(
      parseSystemdEnvAssignments("'OPENCLAW_GATEWAY_TOKEN=single quoted token' FOO=bar"),
    ).toEqual([
      { key: "OPENCLAW_GATEWAY_TOKEN", value: "single quoted token" },
      { key: "FOO", value: "bar" },
    ]);
  });

  it("keeps apostrophes inside unquoted assignment values literal", () => {
    expect(parseSystemdEnvAssignments("FOO=can't OPENCLAW_GATEWAY_TOKEN=token")).toEqual([
      { key: "FOO", value: "can't" },
      { key: "OPENCLAW_GATEWAY_TOKEN", value: "token" },
    ]);
  });
});

describe("parseSystemdExecStart", () => {
  it("preserves quoted arguments", () => {
    const execStart = '/usr/bin/openclaw gateway start --name "My Bot"';
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });
});

describe("readSystemdServiceExecStart", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("strictly distinguishes a missing base unit from an unreadable existing unit", async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(createExecFileError(`Call failed: Unit ${GATEWAY_SERVICE} not found.`), "", "");
    });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("missing service"), { code: "ENOENT" }),
    );
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledWith(
      "busctl",
      expect.arrayContaining(["LoadUnit", GATEWAY_SERVICE]),
      expect.anything(),
      expect.anything(),
    );

    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("unreadable-service-secret-canary"), { code: "EACCES" }),
    );
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow("unreadable-service-secret-canary");
  });

  it.each([false, true])(
    "reads a global user fragment without inventing a managed base (local=%s)",
    async (local) => {
      const fragmentPath = `/etc/systemd/user/${GATEWAY_SERVICE}`;
      const dropInPaths = [`/etc/systemd/user/${GATEWAY_SERVICE}.d/10-operator.conf`];
      vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
        if (file === "/etc/systemd/user/gateway.env") {
          return "OWNER=global\n";
        }
        if (local) {
          return "[Service]\nExecStart=/usr/bin/managed gateway\n";
        }
        throw Object.assign(new Error("missing base"), { code: "ENOENT" });
      });
      mockSystemdManagerSnapshot({
        programArguments: ["/opt/operator/openclaw", "gateway", "run"],
        fragmentPath,
        dropInPaths,
        environmentFiles: [["gateway.env", false]],
        needDaemonReload: true,
      });

      await expect(
        readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
      ).resolves.toEqual({
        programArguments: ["/opt/operator/openclaw", "gateway", "run"],
        environment: { OWNER: "global" },
        environmentValueSources: { OWNER: "file" },
        sourcePath: fragmentPath,
        definitionPaths: [fragmentPath, ...dropInPaths],
        reloadPending: true,
      });
    },
  );

  it.each([
    { name: "unavailable manager", output: new Error("manager-secret-canary") },
    { name: "malformed properties", output: "manager-secret-canary" },
    { name: "wrong property types", output: JSON.stringify({ type: "s", data: "bad" }) },
  ])("strictly rejects a missing local base with $name", async ({ output }) => {
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("missing base"), { code: "ENOENT" }),
    );
    mockSystemdManagerProperties(output);
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow();
    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toBeNull();
  });

  it("requires manager-effective inspection for an existing unit only in strict mode", async () => {
    mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
    mockSystemdManagerProperties(new Error("manager-effective-secret-canary"));

    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow();
    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
    });
  });

  it("parses continued environment assignments using systemd syntax", async () => {
    mockReadGatewayServiceFile([
      "[Service]",
      "ExecStart = /usr/bin/openclaw gateway run",
      "Environment = OPENCLAW_GATEWAY_TOKEN=one \\", // pragma: allowlist secret
      "  # ignored continuation comment",
      "  OPENCLAW_GATEWAY_PASSWORD=two", // pragma: allowlist secret
    ]);
    mockSystemdManagerProperties(new Error("manager unavailable"));

    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "one",
        OPENCLAW_GATEWAY_PASSWORD: "two",
      },
    });
  });

  it.each([false, true])(
    "accepts manager LoadState=not-found before inspecting empty service properties (local=%s)",
    async (local) => {
      if (local) {
        mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
      } else {
        vi.spyOn(fs, "readFile").mockRejectedValue(
          Object.assign(new Error("missing base"), { code: "ENOENT" }),
        );
      }
      mockSystemdManagerProperties(
        new Error("must not inspect a missing service"),
        buildSystemdUnitPropertyOutput({ fragmentPath: "", loadState: "not-found" }),
      );
      await expect(
        readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
      ).resolves.toBeNull();
      expect(execFileMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { name: "malformed LoadUnit", loaded: JSON.stringify({ type: "o", data: [] }) },
    { name: "failed LoadUnit", loaded: new Error("Call failed: Permission denied: secret-canary") },
    { name: "failed property", unit: new Error("Failed to get property LoadState: secret-canary") },
    { name: "empty fragment", unit: buildSystemdUnitPropertyOutput({ fragmentPath: "" }) },
    { name: "empty drop-in", unit: buildSystemdUnitPropertyOutput({ dropInPaths: [""] }) },
    { name: "invalid unit", unit: buildSystemdUnitPropertyOutput({ loadState: "error" }) },
  ])("strictly rejects $name with a missing local base", async ({ loaded, unit }) => {
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("missing base"), { code: "ENOENT" }),
    );
    mockSystemdManagerProperties(
      buildSystemdManagerPropertyOutput({ programArguments: ["/usr/bin/openclaw", "gateway"] }),
      unit,
    );
    if (loaded) {
      execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
        if (loaded instanceof Error) {
          callback(createExecFileError(loaded.message), "", loaded.message);
        } else {
          callback(null, loaded, "");
        }
      });
    }
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow();
  });

  it("does not mistake an unreadable required environment file for a missing base unit", async () => {
    const environmentFile = `${TEST_SERVICE_HOME}/.openclaw/effective.env`;
    mockReadGatewayServiceFile([
      "[Service]",
      "ExecStart=/usr/bin/openclaw gateway run",
      `EnvironmentFile=${environmentFile}`,
    ]);

    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow();
    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
    });
  });

  it("requires manager-effective environment files while preserving optional manager files", async () => {
    const environmentFile = `${TEST_SERVICE_HOME}/.openclaw/effective.env`;
    mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environmentFiles: [[environmentFile, false]],
    });
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).rejects.toThrow();

    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environmentFiles: [[environmentFile, true]],
    });
    await expect(
      readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
    ).resolves.toMatchObject({ programArguments: ["/usr/bin/openclaw", "gateway", "run"] });
  });

  it.each(["ENOENT", "EACCES"])(
    "enforces only active EnvironmentFile inputs (%s)",
    async (code) => {
      const inactive = `${TEST_SERVICE_HOME}/.openclaw/retired.env`;
      const active = `${TEST_SERVICE_HOME}/.openclaw/current.env`;
      const dropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/environment.conf`;
      mockReadGatewayServiceFile(
        ["[Service]", "ExecStart=/usr/bin/openclaw gateway run", `EnvironmentFile=${inactive}`],
        {
          [inactive]: Object.assign(new Error("retired environment unavailable"), { code }),
          [active]: "ACTIVE_VALUE=current\n",
          [dropIn]: `[Service]\nEnvironmentFile=\nEnvironmentFile=${active}\n`,
        },
      );
      mockSystemdManagerSnapshot({
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        environmentFiles: [[active, false]],
        dropInPaths: [dropIn],
      });
      await expect(
        readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
      ).resolves.toMatchObject({
        environment: { ACTIVE_VALUE: "current" },
        sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
        definitionPaths: [`${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`, dropIn],
        managedOverrides: { environment: { keys: ["ACTIVE_VALUE"], resetFiles: true } },
      });
      mockSystemdManagerSnapshot({
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        environmentFiles: [[inactive, false]],
      });
      await expect(
        readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { requireEffective: true }),
      ).rejects.toThrow("retired environment unavailable");
    },
  );

  it("reports one manager-effective command snapshot while retaining the managed base definition", async () => {
    const effectiveArguments = ["/opt/operator/openclaw", "gateway", "run"];
    const objectPath = "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
    const managedEnvironmentFile = `${TEST_SERVICE_HOME}/.openclaw/managed.env`;
    const effectiveEnvironmentFile = `${TEST_SERVICE_HOME}/.openclaw/operator.env`;
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "WorkingDirectory=/srv/managed-openclaw",
        "Environment=BASE_INLINE=base BASE_SHARED=inline",
        `EnvironmentFile=${managedEnvironmentFile}`,
      ],
      {
        [managedEnvironmentFile]: "BASE_SHARED=file\nBASE_FILE=base\n",
        [dropInPath]: [
          "[Unit]",
          "WorkingDirectory=/ignored-unit-section",
          "[Service]",
          "ExecStart=",
          "ExecStart=/opt/operator/openclaw gateway run",
          "WorkingDirectory=/srv/operator-openclaw",
          "Environment=",
          "Environment=INLINE=inline \\",
          " SHARED=inline REMOVE_NAME=inline REMOVE_EXACT=inline",
          "EnvironmentFile=",
          `EnvironmentFile=${effectiveEnvironmentFile}`,
          "UnsetEnvironment=REMOVE_NAME REMOVE_EXACT=matching KEEP_EXACT=wrong",
        ].join("\n"),
        [effectiveEnvironmentFile]: [
          "SHARED=file",
          "FILE_ONLY=file",
          "REMOVE_NAME=file",
          "REMOVE_EXACT=matching",
          "KEEP_EXACT=actual",
        ].join("\n"),
      },
    );
    mockSystemdManagerSnapshot({
      programArguments: effectiveArguments,
      workingDirectory: "!/srv/operator-openclaw",
      environment: ["INLINE=inline", "SHARED=inline", "REMOVE_NAME=inline", "REMOVE_EXACT=inline"],
      environmentFiles: [[effectiveEnvironmentFile, false]],
      unsetEnvironment: ["REMOVE_NAME", "REMOVE_EXACT=matching", "KEEP_EXACT=wrong"],
      dropInPaths: [dropInPath],
    });

    const command = await readSystemdServiceExecStart(
      { HOME: TEST_SERVICE_HOME },
      { timeoutMs: 1234 },
    );

    expect(command).toMatchObject({
      programArguments: effectiveArguments,
      workingDirectory: "/srv/operator-openclaw",
      environment: {
        INLINE: "inline",
        SHARED: "file",
        FILE_ONLY: "file",
        KEEP_EXACT: "actual",
      },
      environmentValueSources: {
        INLINE: "inline",
        SHARED: "inline-and-file",
        FILE_ONLY: "file",
        KEEP_EXACT: "file",
      },
      managedDefinition: {
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/srv/managed-openclaw",
        environment: { BASE_INLINE: "base", BASE_SHARED: "file", BASE_FILE: "base" },
        environmentValueSources: {
          BASE_INLINE: "inline",
          BASE_SHARED: "inline-and-file",
          BASE_FILE: "file",
        },
      },
      managedOverrides: {
        launcher: "command",
        environment: {
          keys: ["INLINE", "SHARED", "REMOVE_NAME", "REMOVE_EXACT", "FILE_ONLY", "KEEP_EXACT"],
          resetInline: true,
          resetFiles: true,
        },
      },
      sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
    });
    expect(execFileMock).toHaveBeenCalledTimes(3);
    for (const [commandName, , options] of execFileMock.mock.calls) {
      expect(commandName).toBe("busctl");
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(1234);
      expect(options.killSignal).toBe("SIGKILL");
    }
    expect(execFileMock.mock.calls[1]?.[1]).toEqual([
      "--user",
      "--json=short",
      "get-property",
      "org.freedesktop.systemd1",
      objectPath,
      "org.freedesktop.systemd1.Unit",
      "FragmentPath",
      "DropInPaths",
      "NeedDaemonReload",
      "LoadState",
    ]);
  });

  it("reads a drop-in-only ExecStart while the managed base remains the ownership anchor", async () => {
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    mockReadGatewayServiceFile(
      ["[Service]", "WorkingDirectory=/srv/managed-openclaw", "Environment=MANAGED_VALUE=base"],
      { [dropInPath]: "[Service]\nExecStart=/opt/operator/openclaw gateway run" },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      workingDirectory: "/srv/operator-openclaw",
      environment: ["OPERATOR_VALUE=effective"],
      dropInPaths: [dropInPath],
    });

    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject({
      programArguments: ["/opt/operator/openclaw", "gateway", "run"],
      managedDefinition: { programArguments: [], environment: { MANAGED_VALUE: "base" } },
      managedOverrides: { launcher: "command" },
    });

    mockSystemdManagerProperties(new Error("systemd manager unavailable"));
    await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toBeNull();
  });

  it("fairly reserves the shared deadline across all three manager queries", async () => {
    mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
    mockSystemdManagerSnapshot({ programArguments: ["/usr/bin/openclaw", "gateway", "run"] });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValueOnce(1_400);

    await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME }, { timeoutMs: 1_200 });

    expect(execFileMock.mock.calls.map((call) => call[2].timeout)).toEqual([400, 550, 800]);
  });

  it.each([false, true])("reports pending manager reload only when it is %s", async (pending) => {
    const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
    const readFile = mockReadGatewayServiceFile(
      ["[Service]", "ExecStart=/usr/bin/openclaw gateway run"],
      { [dropInPath]: "[Service]\nWorkingDirectory=/srv/operator-openclaw" },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      workingDirectory: "/srv/operator-openclaw",
      dropInPaths: [dropInPath],
      needDaemonReload: pending,
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command?.reloadPending).toBe(pending || undefined);
    expect(command?.managedOverrides).toEqual(
      pending ? { launcher: "command", environment: true } : { launcher: "working-directory" },
    );
    expect(readFile).toHaveBeenCalledTimes(pending ? 1 : 2);
  });

  it("does not infer ownership from expanded specifiers or normalized working directories", async () => {
    const workingDirectory = `${TEST_SERVICE_HOME}/Open Claw`;
    mockReadGatewayServiceFile([
      "[Service]",
      "ExecStart=%h/bin/openclaw gateway --unit %n",
      'WorkingDirectory=-"%h/Open Claw"',
      "Environment=OPENCLAW_HOME=%h/openclaw UNIT_NAME=%n",
    ]);
    mockSystemdManagerSnapshot({
      programArguments: [`${TEST_SERVICE_HOME}/bin/openclaw`, "gateway", "--unit", GATEWAY_SERVICE],
      workingDirectory: `!${workingDirectory}`,
      environment: [`OPENCLAW_HOME=${TEST_SERVICE_HOME}/openclaw`, `UNIT_NAME=${GATEWAY_SERVICE}`],
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command).toEqual({
      programArguments: [`${TEST_SERVICE_HOME}/bin/openclaw`, "gateway", "--unit", GATEWAY_SERVICE],
      workingDirectory,
      environment: { OPENCLAW_HOME: `${TEST_SERVICE_HOME}/openclaw`, UNIT_NAME: GATEWAY_SERVICE },
      environmentValueSources: { OPENCLAW_HOME: "inline", UNIT_NAME: "inline" },
      sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
      definitionPaths: [`${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`],
    });
  });

  it.each(["", "# operator note \\", "; operator note \\"])(
    "retains loaded drop-in ownership with comment %j even when values equal the base",
    async (comment) => {
      const dropInPath = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/operator.conf`;
      mockReadGatewayServiceFile(
        [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "WorkingDirectory=/srv/openclaw",
          "Environment=OPENCLAW_GATEWAY_TOKEN=shared NODE_COMPILE_CACHE=/tmp/cache",
        ],
        {
          [dropInPath]: [
            "[Service]",
            comment,
            "ExecStart=",
            comment,
            "ExecStart=/usr/bin/openclaw gateway run",
            comment,
            "WorkingDirectory=/srv/openclaw",
            comment,
            "Environment=OPENCLAW_GATEWAY_TOKEN=shared NODE_COMPILE_CACHE=/tmp/cache",
          ].join("\n"),
        },
      );
      mockSystemdManagerSnapshot({
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/srv/openclaw",
        environment: ["OPENCLAW_GATEWAY_TOKEN=shared", "NODE_COMPILE_CACHE=/tmp/cache"],
        dropInPaths: [dropInPath],
      });

      const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

      expect(command).toMatchObject({
        managedDefinition: { environment: { OPENCLAW_GATEWAY_TOKEN: "shared" } },
        managedOverrides: {
          launcher: "command",
          environment: { keys: ["OPENCLAW_GATEWAY_TOKEN", "NODE_COMPILE_CACHE"] },
        },
      });
    },
  );

  it("preserves managed removals while clearing superseded drop-in ownership in directive order", async () => {
    const firstDropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/10-file.conf`;
    const resetDropIn = `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}.d/20-reset.conf`;
    const operatorEnv = `${TEST_SERVICE_HOME}/.openclaw/operator.env`;
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "Environment=FOO=base BAR=base",
        "UnsetEnvironment=BAR",
      ],
      {
        [firstDropIn]: `[Service]\nEnvironmentFile=${operatorEnv}\n`,
        [resetDropIn]: "[Service]\nEnvironmentFile=\nUnsetEnvironment=FOO\nUnsetEnvironment=\n",
        [operatorEnv]: "FOO=operator\n",
      },
    );
    mockSystemdManagerSnapshot({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: ["FOO=base", "BAR=base"],
      dropInPaths: [firstDropIn, resetDropIn],
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command).toMatchObject({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: { FOO: "base", BAR: "base" },
      environmentValueSources: { FOO: "inline", BAR: "inline" },
      managedDefinition: { environment: { FOO: "base" } },
      managedOverrides: { environment: { keys: ["BAR"], resetFiles: true } },
      sourcePath: `${TEST_SERVICE_HOME}/.config/systemd/user/${GATEWAY_SERVICE}`,
    });
  });

  it("reads manager-expanded EnvironmentFile globs in deterministic precedence order", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-glob-"));
    const env = { HOME: home };
    const unitPath = resolveSystemdUnitPath(env);
    const environmentDir = path.join(home, "env.d");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.mkdir(environmentDir);
      await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/openclaw gateway run\n");
      await fs.writeFile(path.join(environmentDir, "20-override.env"), "SHARED=second\n");
      await fs.writeFile(path.join(environmentDir, "10-base.env"), "SHARED=first\n");
      mockSystemdManagerSnapshot({
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        environment: ["SHARED=inline"],
        fragmentPath: unitPath,
        environmentFiles: [[path.join(environmentDir, "*.env"), false]],
      });

      const command = await readSystemdServiceExecStart(env);

      expect(command?.environment).toEqual({ SHARED: "second" });
      expect(command?.environmentValueSources).toEqual({ SHARED: "inline-and-file" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "loaded ownership", properties: JSON.stringify({ type: "as", data: [] }) },
    {
      name: "pending reload state",
      properties: buildSystemdUnitPropertyOutput({}).replace(
        JSON.stringify({ type: "b", data: false }),
        JSON.stringify({ type: "b", data: "false" }),
      ),
    },
  ])(
    "falls back to the coherent managed snapshot when $name is malformed",
    async ({ properties }) => {
      mockReadGatewayServiceFile([
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "WorkingDirectory=/srv/managed-openclaw",
        "Environment=MANAGED_VALUE=base",
      ]);
      mockSystemdManagerProperties(
        buildSystemdManagerPropertyOutput({
          programArguments: ["/opt/operator/openclaw", "gateway", "run"],
          environment: ["OPERATOR_VALUE=effective"],
        }),
        properties,
      );

      await expect(readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME })).resolves.toMatchObject(
        {
          programArguments: ["/usr/bin/openclaw", "gateway", "run"],
          workingDirectory: "/srv/managed-openclaw",
          environment: { MANAGED_VALUE: "base" },
          environmentValueSources: { MANAGED_VALUE: "inline" },
          managedDefinition: {
            programArguments: ["/usr/bin/openclaw", "gateway", "run"],
            workingDirectory: "/srv/managed-openclaw",
            environment: { MANAGED_VALUE: "base" },
            environmentValueSources: { MANAGED_VALUE: "inline" },
          },
          managedOverrides: { launcher: "command", environment: true },
        },
      );
    },
  );

  it("bounds manager lookup for callers without a timeout before local fallback", async () => {
    mockReadGatewayServiceFile(["[Service]", "ExecStart=/usr/bin/openclaw gateway run"]);
    execFileMock.mockReset();
    execFileMock.mockImplementation((command, _args, options, callback) => {
      expect(command).toBe("busctl");
      expect(options.timeout).toEqual(expect.any(Number));
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(Math.floor(5_000 / 3));
      callback(createExecFileError("manager query timed out"), "", "manager query timed out");
    });

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command?.programArguments).toEqual(["/usr/bin/openclaw", "gateway", "run"]);
    expect(command?.managedDefinition).toEqual({
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
    });
    expect(command?.managedOverrides).toEqual({ launcher: "command", environment: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("loads OPENCLAW_GATEWAY_TOKEN from EnvironmentFile", async () => {
    const readFileSpy = mockReadGatewayServiceFile(
      ["[Service]", "ExecStart=/usr/bin/openclaw gateway run", "EnvironmentFile=%h/.openclaw/.env"],
      { [`${TEST_SERVICE_HOME}/.openclaw/.env`]: "OPENCLAW_GATEWAY_TOKEN=env-file-token\n" },
    );

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });
    expect(command?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("env-file-token");
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it("lets EnvironmentFile override inline Environment values", async () => {
    mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "EnvironmentFile=%h/.openclaw/.env",
        'Environment="OPENCLAW_GATEWAY_TOKEN=inline-token"',
      ],
      { [`${TEST_SERVICE_HOME}/.openclaw/.env`]: "OPENCLAW_GATEWAY_TOKEN=env-file-token\n" },
    );

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });
    expect(command?.environment?.OPENCLAW_GATEWAY_TOKEN).toBe("env-file-token");
    expect(command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN).toBe("inline-and-file");
  });

  it("applies managed directive resets before ordered environment assignments and removals", async () => {
    const staleFile = `${TEST_SERVICE_HOME}/.openclaw/stale.env`;
    const readFileSpy = mockReadGatewayServiceFile(
      [
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "Environment=STALE_INLINE=discarded",
        "Environment=",
        'Environment=PLAIN=first "QUOTED=value with spaces" REPEATED=first',
        "Environment='REPEATED=last value' INLINE_FILE=inline REMOVE_NAME=inline REMOVE_EXACT=inline KEEP_MISMATCH=inline",
        `EnvironmentFile=${staleFile}`,
        "EnvironmentFile=",
        "EnvironmentFile=%h/.openclaw/.env",
        "UnsetEnvironment=PLAIN",
        "UnsetEnvironment=",
        "UnsetEnvironment=REMOVE_NAME",
        'UnsetEnvironment="REMOVE_EXACT=final value" KEEP_MISMATCH=wrong-value',
      ],
      {
        [staleFile]: "STALE_FILE=discarded\n",
        [`${TEST_SERVICE_HOME}/.openclaw/.env`]: [
          "INLINE_FILE=file",
          "FILE_ONLY=from-file",
          "REMOVE_NAME=file",
          "REMOVE_EXACT=final value",
          "KEEP_MISMATCH=file",
        ].join("\n"),
      },
    );
    mockSystemdManagerProperties(new Error("systemd manager unavailable"));

    const command = await readSystemdServiceExecStart({ HOME: TEST_SERVICE_HOME });

    expect(command?.environment).toEqual({
      PLAIN: "first",
      QUOTED: "value with spaces",
      REPEATED: "last value",
      INLINE_FILE: "file",
      FILE_ONLY: "from-file",
      KEEP_MISMATCH: "file",
    });
    expect(command?.environmentValueSources).toEqual({
      PLAIN: "inline",
      QUOTED: "inline",
      REPEATED: "inline",
      INLINE_FILE: "inline-and-file",
      FILE_ONLY: "file",
      KEEP_MISMATCH: "inline-and-file",
    });
    expect(readFileSpy).not.toHaveBeenCalledWith(staleFile, "utf8");
  });

  it("ignores missing optional EnvironmentFile entries", async () => {
    await expectExecStartWithoutEnvironment("EnvironmentFile=-%h/.openclaw/missing.env");
  });

  it("keeps parsing when non-optional EnvironmentFile entries are missing", async () => {
    await expectExecStartWithoutEnvironment("EnvironmentFile=%h/.openclaw/missing.env");
  });

  it("supports multiple EnvironmentFile entries and quoted paths", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      const pathValue = pathLikeToString(pathname);
      if (pathValue.endsWith("/openclaw-gateway.service")) {
        return [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          'EnvironmentFile=%h/.openclaw/first.env "%h/.openclaw/second env.env"',
        ].join("\n");
      }
      if (pathValue === "/home/test/.openclaw/first.env") {
        return "OPENCLAW_GATEWAY_TOKEN=first-token\n"; // pragma: allowlist secret
      }
      if (pathValue === "/home/test/.openclaw/second env.env") {
        return 'OPENCLAW_GATEWAY_PASSWORD="second password"\n'; // pragma: allowlist secret
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "first-token",
      OPENCLAW_GATEWAY_PASSWORD: "second password", // pragma: allowlist secret
    });
  });

  it("resolves relative EnvironmentFile paths from the unit directory", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      const pathValue = pathLikeToString(pathname);
      if (pathValue.endsWith("/openclaw-gateway.service")) {
        return [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "EnvironmentFile=./gateway.env ./override.env",
        ].join("\n");
      }
      if (pathValue.endsWith("/.config/systemd/user/gateway.env")) {
        return [
          "OPENCLAW_GATEWAY_TOKEN=relative-token", // pragma: allowlist secret
          "OPENCLAW_GATEWAY_PASSWORD=relative-password", // pragma: allowlist secret
        ].join("\n");
      }
      if (pathValue.endsWith("/.config/systemd/user/override.env")) {
        return "OPENCLAW_GATEWAY_TOKEN=override-token\n"; // pragma: allowlist secret
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "override-token",
      OPENCLAW_GATEWAY_PASSWORD: "relative-password", // pragma: allowlist secret
    });
  });

  it("parses EnvironmentFile content with comments and quoted values", async () => {
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      const pathValue = pathLikeToString(pathname);
      if (pathValue.endsWith("/openclaw-gateway.service")) {
        return [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "EnvironmentFile=%h/.openclaw/gateway.env",
        ].join("\n");
      }
      if (pathValue === "/home/test/.openclaw/gateway.env") {
        return [
          "# comment",
          "; another comment",
          'OPENCLAW_GATEWAY_TOKEN="quoted token"', // pragma: allowlist secret
          'OPENCLAW_GATEWAY_PASSWORD="symbol \\" \\\\ \\$ \\`"', // pragma: allowlist secret
          'MIXED_API_KEY="55\\"55" "FIVE" cinco',
          'UNQUOTED_QUOTES_API_KEY=foo"bar"',
        ].join("\n");
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "quoted token",
      OPENCLAW_GATEWAY_PASSWORD: 'symbol " \\ $ `', // pragma: allowlist secret
      MIXED_API_KEY: '55"55FIVEcinco',
      UNQUOTED_QUOTES_API_KEY: 'foo"bar"',
    });
    expect(command?.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
      MIXED_API_KEY: "file",
      UNQUOTED_QUOTES_API_KEY: "file",
    });
  });
});

describe("stageSystemdService", () => {
  async function withStageFixture(
    run: (context: {
      env: Record<string, string>;
      stateDir: string;
      unitPath: string;
      envFilePath: string;
      nodeEnvFilePath: string;
    }) => Promise<void>,
  ): Promise<void> {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-stage-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-stage-test",
    };
    const unitPath = resolveSystemdUnitPath(env);
    const envFilePath = path.join(stateDir, "gateway.systemd.env");
    const nodeEnvFilePath = path.join(stateDir, "node.systemd.env");

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, stateDir, unitPath, envFilePath, nodeEnvFilePath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  function mockSystemctlStatusOk(): void {
    execFileMock.mockImplementationOnce(systemctlUserSuccess("status"));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
    vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (env) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-gateway-work"}.service not found.`,
    }));
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
  });

  it.each(["", "# operator note \\", "; operator note \\"])(
    "removes legacy gateway version metadata with comment %j without restarting",
    async (comment) => {
      await withStageFixture(async ({ env, unitPath }) => {
        await fs.mkdir(path.dirname(unitPath), { recursive: true });
        await fs.writeFile(
          unitPath,
          [
            "[Unit]",
            "Description=OpenClaw Gateway (v2026.7.1-2)",
            "",
            "[Service]",
            comment,
            "ExecStart=/usr/bin/openclaw gateway run",
            "Environment=OPENCLAW_SERVICE_MARKER=openclaw \\",
            "  # managed stamps span physical lines",
            "  OPENCLAW_SERVICE_KIND=gateway",
            'Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2 "OTHER_SETTING=kept value"',
            "Environment=OPENCLAW_GATEWAY_PORT=18789",
            "",
          ].join("\n"),
          "utf8",
        );
        execFileMock.mockImplementationOnce(systemctlUserSuccess("daemon-reload"));

        await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(true);

        const unit = await fs.readFile(unitPath, "utf8");
        expect(unit).toContain("Description=OpenClaw Gateway\n");
        expect(unit.split("\n")).toContain("ExecStart=/usr/bin/openclaw gateway run");
        expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
        expect(unit).toContain('Environment="OTHER_SETTING=kept value"');
        expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
        expect(execFileMock).toHaveBeenCalledTimes(1);
        for (const [, timeoutMs] of assertNoSystemSystemdOwnershipMock.mock.calls) {
          expect(timeoutMs).toBeGreaterThan(0);
          expect(timeoutMs).toBeLessThanOrEqual(5_000);
        }
        expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledTimes(3);
        expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
          killSignal: "SIGKILL",
          timeout: expect.any(Number),
        });
      });
    },
  );

  it("preserves a hand-written unit with the formerly documented version metadata", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      const previous = [
        "[Unit]",
        "Description=OpenClaw Gateway (v2026.7.1-2)",
        "",
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run",
        "Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2",
        "",
      ].join("\n");
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, previous, "utf8");
      execFileMock.mockImplementationOnce(systemctlUserSuccess("daemon-reload"));

      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(false);

      await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      label: "version marker does not match the Description",
      environment: [
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
        "Environment=OPENCLAW_SERVICE_KIND=gateway",
        "Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-1",
      ],
    },
    {
      label: "managed markers were reset",
      environment: [
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw OPENCLAW_SERVICE_KIND=gateway",
        "Environment=",
        "Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2",
      ],
    },
  ])("preserves a unit when $label", async ({ environment }) => {
    await withStageFixture(async ({ env, unitPath }) => {
      const previous = [
        "[Unit]",
        "Description=OpenClaw Gateway (v2026.7.1-2)",
        "",
        "[Service]",
        ...environment,
        "",
      ].join("\n");
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, previous, "utf8");

      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(false);

      await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      expect(assertNoSystemSystemdOwnershipMock).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  it("preserves legacy metadata when the system unit owns the gateway name", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      const previous = [
        "[Unit]",
        "Description=OpenClaw Gateway (v2026.7.1-2)",
        "",
        "[Service]",
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
        "Environment=OPENCLAW_SERVICE_KIND=gateway",
        "Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2",
        "",
      ].join("\n");
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, previous, "utf8");
      assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(new Error("system ownership"));

      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).rejects.toThrow(
        "system ownership",
      );

      await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  it("restores legacy metadata when system ownership appears after publication", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      const previous = [
        "[Unit]",
        "Description=OpenClaw Gateway (v2026.7.1-2)",
        "",
        "[Service]",
        "Environment=OPENCLAW_SERVICE_MARKER=openclaw",
        "Environment=OPENCLAW_SERVICE_KIND=gateway",
        "Environment=OPENCLAW_SERVICE_VERSION=2026.7.1-2",
        "",
      ].join("\n");
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, previous, "utf8");
      assertNoSystemSystemdOwnershipMock
        .mockResolvedValueOnce()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error("system ownership appeared"));

      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).rejects.toThrow(
        "system ownership appeared",
      );

      await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  it("blocks before mutating user files when the same system unit owns the name", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath }) => {
      const previous = "[Unit]\nDescription=Existing user gateway\n";
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, previous, "utf8");
      mockSystemctlStatusOk();
      assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(
        new Error("system scope owns openclaw-gateway-stage-test.service"),
      );

      await expect(
        stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789")),
      ).rejects.toThrow("system scope owns openclaw-gateway-stage-test.service");

      await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      await expect(fs.access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledWith(
        "openclaw-gateway-stage-test.service",
      );
    });
  });

  it("rolls back a new environment file when ownership appears before publication", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath }) => {
      mockSystemctlStatusOk();
      assertNoSystemSystemdOwnershipMock
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error("system ownership appeared"));

      await expect(
        stageSystemdService(
          gatewaySystemdServiceFixture(env, {
            environment: {
              OPENCLAW_GATEWAY_PORT: "18789",
              OPENCLAW_GATEWAY_TOKEN: "new-token",
            },
            environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
          }),
        ),
      ).rejects.toThrow("system ownership appeared");

      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("restores existing unit and environment files after a publication race", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath }) => {
      const previous = "[Unit]\nDescription=Previous gateway\n";
      const previousEnv = "OPENCLAW_GATEWAY_TOKEN=previous-token\n";
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, previous, "utf8");
      await fs.writeFile(envFilePath, previousEnv, "utf8");
      await Promise.all([fs.chmod(unitPath, 0o400), fs.chmod(envFilePath, 0o400)]);
      mockSystemctlStatusOk();
      assertNoSystemSystemdOwnershipMock
        .mockResolvedValueOnce()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error("system ownership appeared"));

      await expect(
        stageSystemdService(
          gatewaySystemdServiceFixture(env, {
            environment: {
              OPENCLAW_GATEWAY_PORT: "18789",
              OPENCLAW_GATEWAY_TOKEN: "new-token",
            },
            environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
          }),
        ),
      ).rejects.toThrow("system ownership appeared");

      const [unitStat, environmentStat] = await Promise.all([
        fs.stat(unitPath),
        fs.stat(envFilePath),
      ]);
      expect(unitStat.mode & 0o777).toBe(0o400);
      expect(environmentStat.mode & 0o777).toBe(0o400);
      await expect(fs.readFile(unitPath, "utf8")).resolves.toBe(previous);
      await expect(fs.readFile(envFilePath, "utf8")).resolves.toBe(previousEnv);
    });
  });

  it("uses the profile-derived gateway unit name for ownership checks", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-profile-"));
    const env = {
      HOME: path.join(tempHomeRoot, "home"),
      OPENCLAW_STATE_DIR: path.join(tempHomeRoot, "state"),
      OPENCLAW_PROFILE: "work",
    };
    try {
      mockSystemctlStatusOk();
      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));
      expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledWith(
        "openclaw-gateway-work.service",
      );
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("rechecks ownership before install activation", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      mockSystemctlStatusOk();
      assertNoSystemSystemdOwnershipMock
        .mockResolvedValueOnce()
        .mockResolvedValueOnce()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error("system ownership appeared before activation"));

      await expect(
        installSystemdService(gatewayPortSystemdServiceFixture(env, "18789")),
      ).rejects.toThrow("system ownership appeared before activation");

      await expect(fs.access(unitPath)).resolves.toBeUndefined();
      expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledTimes(4);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  it("leaves dotenv-backed values to gateway startup so restarts observe edits", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        ["OPENCLAW_GATEWAY_TOKEN=dotenv-token", "LLM_API_KEY=dotenv-key"].join("\n"),
        "utf8",
      );

      mockSystemctlStatusOk();

      await stageSystemdService(
        gatewaySystemdServiceFixture(env, {
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "dotenv-token",
            LLM_API_KEY: "dotenv-key",
            OPENCLAW_GATEWAY_PORT: "18789",
          },
        }),
      );

      const unit = await fs.readFile(unitPath, "utf8");

      expect(unit).toContain("Description=OpenClaw Gateway");
      expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
      expect(unit).not.toContain("EnvironmentFile=");
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=dotenv-token");
      expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
      await expect(fs.access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("drops previously managed dotenv keys on restage while preserving operator entries", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath, stateDir }) => {
      const wrapperPath = path.join(stateDir, "openclaw-wrapper");
      await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await fs.writeFile(
        envFilePath,
        "OPENAI_API_KEY=stale-managed\nOPERATOR_API_KEY=operator-owned\n",
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(
        unitPath,
        [
          "[Service]",
          `ExecStart=${wrapperPath} gateway run`,
          `EnvironmentFile=-${envFilePath}`,
          "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY",
        ].join("\n"),
        "utf8",
      );
      mockSystemctlStatusOk();

      await stageSystemdService(
        systemdServiceFixture(env, [wrapperPath, "gateway", "run"], {
          workingDirectory: "/tmp",
          environment: { OPENCLAW_GATEWAY_PORT: "18789" },
        }),
      );

      expect(await fs.readFile(envFilePath, "utf8")).toBe("OPERATOR_API_KEY=operator-owned\n");
      expect(await fs.readFile(unitPath, "utf8")).toContain(`EnvironmentFile=-${envFilePath}`);
    });
  });

  it("round-trips file-managed secrets through parse, repair planning, and emit", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath, stateDir }) => {
      const wrapperPath = path.join(stateDir, "openclaw-wrapper");
      const fileBackedOpenAiKey = "file-backed-openai-test-key";
      await fs.writeFile(wrapperPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await fs.chmod(wrapperPath, 0o755);
      await fs.writeFile(envFilePath, `OPENAI_API_KEY=${fileBackedOpenAiKey}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(
        unitPath,
        [
          "[Service]",
          `ExecStart=${wrapperPath} gateway --port 18789`,
          `EnvironmentFile=-${envFilePath}`,
          "Environment=HOME=" + env.HOME,
          "Environment=OPENCLAW_GATEWAY_PORT=18789",
          "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY",
        ].join("\n"),
        "utf8",
      );

      const command = await readSystemdServiceExecStart(env);
      expect(command?.environment?.OPENAI_API_KEY).toBe(fileBackedOpenAiKey);
      expect(command?.environmentValueSources?.OPENAI_API_KEY).toBe("file");
      expect(command?.environmentValueSources?.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("inline");

      const plan = await buildGatewayInstallPlan({
        env: { ...env, PATH: "/usr/bin:/bin" },
        port: 18_789,
        runtime: "node",
        platform: "linux",
        runtimePath: process.execPath,
        wrapperPath,
        existingEnvironment: command?.environment,
        existingEnvironmentValueSources: command?.environmentValueSources,
        authStore: { version: 1, profiles: {} },
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [],
              },
            },
          },
        },
      });
      expect(plan.environmentValueSources?.OPENAI_API_KEY).toBe("file");
      expect(plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("OPENAI_API_KEY");

      mockSystemctlStatusOk();
      await stageSystemdService({
        env,
        stdout: createWritableStreamMock().stdout,
        ...plan,
      });

      const [rewrittenUnit, rewrittenEnvFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);
      expect(rewrittenUnit).toContain(`EnvironmentFile=-${envFilePath}`);
      expect(rewrittenUnit).toContain(
        "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENAI_API_KEY",
      );
      expect(rewrittenUnit).not.toContain(fileBackedOpenAiKey);
      expect(rewrittenEnvFile).toBe(`OPENAI_API_KEY=${fileBackedOpenAiKey}\n`);
    });
  });

  it("matches differently-cased source metadata when writing node file-backed values", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath, nodeEnvFilePath }) => {
      await fs.rm(stateDir, { recursive: true, force: true });
      const gatewayPassword = 'symbol " \\ $ `'; // pragma: allowlist secret

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: createWritableStreamMock().stdout,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "file-backed-token",
          OPENCLAW_GATEWAY_PASSWORD: gatewayPassword,
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_PASSWORD,OPENCLAW_GATEWAY_TOKEN", // pragma: allowlist secret
          OPENCLAW_SERVICE_KIND: "node",
        },
        environmentValueSources: {
          openclaw_gateway_token: "file",
          openclaw_gateway_password: "file", // pragma: allowlist secret
          openclaw_service_managed_env_keys: "inline",
        },
      });

      const [unit, envFile, envFileStat] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(nodeEnvFilePath, "utf8"),
        fs.stat(nodeEnvFilePath),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${nodeEnvFilePath}`);
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=file-backed-token");
      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_PASSWORD=");
      expect(envFile).toBe(
        'OPENCLAW_GATEWAY_TOKEN=file-backed-token\nOPENCLAW_GATEWAY_PASSWORD="symbol \\" \\\\ \\$ \\`"\n',
      );
      expect(envFileStat.mode & 0o777).toBe(0o600);
      await expect(readSystemdServiceExecStart(env)).resolves.toMatchObject({
        environment: {
          OPENCLAW_GATEWAY_PASSWORD: gatewayPassword,
        },
      });
      await expect(fs.access(envFilePath)).rejects.toThrow();
    });
  });

  it("migrates operator entries from the legacy gateway env file when writing node env files", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath, nodeEnvFilePath }) => {
      const legacyGatewayEnvFile =
        ["OPENCLAW_GATEWAY_TOKEN=legacy-node-token", "OPENROUTER_API_KEY=operator-key"].join("\n") +
        "\n";
      await fs.writeFile(envFilePath, legacyGatewayEnvFile, {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService(
        nodeSystemdServiceFixture(env, {
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "fresh-file-token",
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_SERVICE_KIND: "node",
          },
          environmentValueSources: {
            OPENCLAW_GATEWAY_TOKEN: "file",
          },
        }),
      );

      const [unit, nodeEnvFile, gatewayEnvFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(nodeEnvFilePath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${nodeEnvFilePath}`);
      expect(unit).not.toContain("OPENCLAW_GATEWAY_TOKEN=fresh-file-token");
      expect(nodeEnvFile).toBe(
        "OPENROUTER_API_KEY=operator-key\nOPENCLAW_GATEWAY_TOKEN=fresh-file-token\n",
      );
      expect(gatewayEnvFile).toBe(legacyGatewayEnvFile);
    });
  });

  it("clears stale node file-backed managed keys without touching the gateway env file", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath, nodeEnvFilePath }) => {
      await fs.writeFile(envFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-token\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.writeFile(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=stale-node-token\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService(
        nodeSystemdServiceFixture(env, {
          environment: {
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_SERVICE_KIND: "node",
          },
          environmentValueSources: {
            OPENCLAW_GATEWAY_TOKEN: "file",
          },
        }),
      );

      const unit = await fs.readFile(unitPath, "utf8");

      expect(unit).not.toContain("EnvironmentFile=");
      await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe("");
      await expect(fs.readFile(envFilePath, "utf8")).resolves.toBe(
        "OPENCLAW_GATEWAY_TOKEN=stale-token\n",
      );
    });
  });

  it("does not re-stage unresolved inline-and-file values from preserved service env (#88274)", async () => {
    await withStageFixture(async ({ env, unitPath, envFilePath }) => {
      await fs.writeFile(envFilePath, "LLM_API_KEY=$SECRET_FROM_SHELL\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService(
        gatewaySystemdServiceFixture(env, {
          environment: {
            LLM_API_KEY: "$SECRET_FROM_SHELL",
            OPENCLAW_GATEWAY_PORT: "18789",
          },
          environmentValueSources: {
            LLM_API_KEY: "inline-and-file",
          },
        }),
      );

      const unit = await fs.readFile(unitPath, "utf8");
      expect(unit).not.toContain("EnvironmentFile=");
      expect(unit).not.toContain("LLM_API_KEY");
      expect(unit).not.toContain("$SECRET_FROM_SHELL");
      await expect(fs.readFile(envFilePath, "utf8")).resolves.toBe("");
    });
  });

  it.each(["", "# operator note \\", "; operator note \\"])(
    "sanitizes file-backed backup values with comment %j on re-stage",
    async (comment) => {
      await withStageFixture(async ({ env, unitPath }) => {
        await fs.mkdir(path.dirname(unitPath), { recursive: true });
        await fs.writeFile(
          unitPath,
          [
            "[Service]",
            comment,
            "ExecStart=/usr/bin/openclaw node run",
            comment,
            "Environment=FOO=bar OPENCLAW_GATEWAY_TOKEN=inline-token BAZ=qux",
            "Environment=OPENCLAW_GATEWAY_TOKEN=token-only-line",
            "Environment='OPENCLAW_GATEWAY_TOKEN=single-quoted-token' FROM_SINGLE=kept",
            "Environment=",
            "Environment=OPENCLAW_GATEWAY_PORT=18789",
          ].join("\n"),
          { encoding: "utf8", mode: 0o600 },
        );
        await fs.chmod(unitPath, 0o600);

        mockSystemctlStatusOk();

        await stageSystemdService(
          nodeSystemdServiceFixture(env, {
            environment: {
              OPENCLAW_GATEWAY_TOKEN: "fresh-token",
              OPENCLAW_GATEWAY_PORT: "18789",
              OPENCLAW_SERVICE_KIND: "node",
            },
            environmentValueSources: {
              OPENCLAW_GATEWAY_TOKEN: "file",
            },
          }),
        );

        const [unit, backupUnit, backupStat] = await Promise.all([
          fs.readFile(unitPath, "utf8"),
          fs.readFile(`${unitPath}.bak`, "utf8"),
          fs.stat(`${unitPath}.bak`),
        ]);

        expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-token");
        expect(backupUnit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=inline-token");
        expect(backupUnit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=token-only-line");
        expect(backupUnit).not.toContain("single-quoted-token");
        expect(backupUnit).toContain("[Service]");
        expect(backupUnit.split("\n")).toContain("ExecStart=/usr/bin/openclaw node run");
        expect(backupUnit).toContain("Environment=FOO=bar BAZ=qux");
        expect(backupUnit).toContain("Environment=FROM_SINGLE=kept\nEnvironment=\n");
        expect(backupUnit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
        expect(backupStat.mode & 0o777).toBe(0o600);
      });
    },
  );

  it("protects tokenless gateway units and backups from legacy credentials", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(
        unitPath,
        [
          "[Service]",
          "ExecStart=/opt/operator/openclaw gateway run --operator-flag",
          "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept \\",
          "  # legacy installer note",
          "  OPENCLAW_GATEWAY_PASSWORD=legacy-password",
          "RestartSec=17",
        ].join("\n"),
        { encoding: "utf8", mode: 0o644 },
      );
      await fs.chmod(unitPath, 0o644);
      mockSystemctlStatusOk();

      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));

      const [unit, backup, unitStat, backupStat] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(`${unitPath}.bak`, "utf8"),
        fs.stat(unitPath),
        fs.stat(`${unitPath}.bak`),
      ]);
      expect(unit).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(unit).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
      expect(backup).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(backup).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
      expect(backup).toContain("CUSTOM_SETTING=kept");
      expect(backup).toContain("RestartSec=17");
      expect(unitStat.mode & 0o777).toBe(0o600);
      expect(backupStat.mode & 0o777).toBe(0o600);
    });
  });

  it("restores an orphan backup when later staging fails", async () => {
    await withStageFixture(async ({ env, unitPath }) => {
      const backupPath = `${unitPath}.bak`;
      const previous =
        "[Service]\nEnvironment=OPENCLAW_GATEWAY_TOKEN=legacy-token CUSTOM_SETTING=kept\n";
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, previous, { encoding: "utf8", mode: 0o640 });
      await fs.chmod(backupPath, 0o640);
      mockSystemctlStatusOk();

      await expect(
        stageSystemdService(
          gatewaySystemdServiceFixture(env, {
            environment: {
              OPENCLAW_GATEWAY_PORT: "18789",
              OPENCLAW_GATEWAY_TOKEN: "invalid\nmultiline",
            },
            environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
          }),
        ),
      ).rejects.toThrow("systemd EnvironmentFile values must be single-line");

      const restored = await fs.stat(backupPath);
      expect(restored.mode & 0o777).toBe(0o640);
      await expect(fs.readFile(backupPath, "utf8")).resolves.toBe(previous);
      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("keeps explicit inline overrides while leaving dotenv values to gateway startup", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        [
          "OPENCLAW_GATEWAY_TOKEN=stale-token",
          "LLM_API_KEY=dotenv-key",
          "toString=dotenv-string",
        ].join("\n"),
        "utf8",
      );

      mockSystemctlStatusOk();

      await stageSystemdService(
        gatewaySystemdServiceFixture(env, {
          environment: {
            OPENCLAW_GATEWAY_TOKEN: "fresh-token",
            LLM_API_KEY: "dotenv-key",
            constructor: "inline-constructor",
            toString: "dotenv-string",
          },
        }),
      );

      const unit = await fs.readFile(unitPath, "utf8");

      expect(unit).not.toContain("EnvironmentFile=");
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-token");
      expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
      expect(unit).toContain("Environment=constructor=inline-constructor");
      expect(unit).not.toContain("Environment=toString=dotenv-string");
      await expect(fs.access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("clears stale inline-managed keys from env file on re-stage (#76860)", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      // Existing env file carries a stale OPENCLAW_GATEWAY_TOKEN that the
      // operator previously wrote there but staging now supplies inline.
      await fs.writeFile(
        envFilePath,
        [
          "OPENCLAW_GATEWAY_TOKEN=stale-gateway-token",
          "OPENROUTER_API_KEY=or-operator-key",
          "NODE_OPTIONS=--require=/tmp/stale-preload.cjs",
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=dotenv-key\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: createWritableStreamMock().stdout,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        // Staging manages OPENCLAW_GATEWAY_TOKEN inline; OPENCLAW_SERVICE_MANAGED_ENV_KEYS
        // marks it as an OpenClaw-managed key so the stale env-file copy is cleared.
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-gateway-token",
          LLM_API_KEY: "dotenv-key",
          OPENROUTER_API_KEY: "or-operator-key",
          NODE_OPTIONS: "",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "inline-and-file",
          LLM_API_KEY: "inline",
          OPENROUTER_API_KEY: "file",
          NODE_OPTIONS: "inline",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "inline",
        },
      });

      const [unit, envFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);
      // Stale inline-managed key must be removed from the env file so the
      // fresh inline Environment= value wins (EnvironmentFile would override it).
      expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN");
      expect(envFile).not.toContain("NODE_OPTIONS");
      expect(unit).toContain("Environment=NODE_OPTIONS=\n");
      // Operator-added key not managed inline must survive.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).not.toContain("LLM_API_KEY");
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-gateway-token");
      expect(unit).not.toContain("Environment=OPENROUTER_API_KEY=or-operator-key");
      expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
    });
  });

  it("preserves operator secrets when incoming .env is empty (#76860)", async () => {
    await withStageFixture(async ({ env, envFilePath }) => {
      // Existing env file has only operator-added secrets; state-dir .env is absent/empty.
      await fs.writeFile(envFilePath, "OPENROUTER_API_KEY=or-operator-key\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      mockSystemctlStatusOk();

      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));

      const envFile = await fs.readFile(envFilePath, "utf8");
      // Operator-only secret must survive even when no dotenv vars are staged.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    });
  });

  it("preserves operator-added secrets in existing env file on re-stage (#76860)", async () => {
    await withStageFixture(async ({ env, stateDir, envFilePath }) => {
      // Simulate operator pre-populating gateway.systemd.env with provider API keys.
      await fs.writeFile(
        envFilePath,
        [
          "ANTHROPIC_API_KEY=sk-ant-operator-secret",
          "OPENROUTER_API_KEY=or-operator-key",
          "LLM_API_KEY=old-value",
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      // State-dir .env only provides LLM_API_KEY (not the provider secrets).
      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=new-value\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService(
        gatewaySystemdServiceFixture(env, {
          environment: { LLM_API_KEY: "new-value" },
        }),
      );

      const envFile = await fs.readFile(envFilePath, "utf8");
      // Operator secrets survive; the state-dir key is loaded directly by Gateway startup.
      expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).not.toContain("LLM_API_KEY");
    });
  });

  it("preserves explicit literal shell references and mixed quoted values", async () => {
    await withStageFixture(async ({ env, envFilePath }) => {
      await fs.writeFile(
        envFilePath,
        [
          "OPENROUTER_API_KEY=\\$SECRET_FROM_SHELL",
          "SINGLE_QUOTED_LITERAL_API_KEY='$SECRET_FROM_SHELL'",
          'DOUBLE_QUOTED_LITERAL_API_KEY="$SECRET_FROM_SHELL"',
          'MIXED_API_KEY="foo"bar',
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      mockSystemctlStatusOk();

      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));

      const envFile = await fs.readFile(envFilePath, "utf8");
      expect(envFile).toContain('OPENROUTER_API_KEY="\\$SECRET_FROM_SHELL"');
      expect(envFile).toContain('SINGLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"');
      expect(envFile).toContain('DOUBLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"');
      expect(envFile).toContain("MIXED_API_KEY=foobar");
    });
  });

  it("removes a stale literal reference on re-stage when state-dir .env now skips that key (#88274)", async () => {
    await withStageFixture(async ({ env, stateDir, envFilePath }) => {
      // A prior install generated a literal reference for LLM_API_KEY (an unexpanded
      // $VAR that dotenv stored verbatim) and an operator-managed provider secret.
      await fs.writeFile(
        envFilePath,
        ["LLM_API_KEY=$SECRET_FROM_SHELL", "OPENROUTER_API_KEY=or-operator-key"].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      // The state-dir .env still declares LLM_API_KEY but now as an unresolved
      // shell reference, so the parser skips it from the managed environment.
      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=$SECRET_FROM_SHELL\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));

      const envFile = await fs.readFile(envFilePath, "utf8");
      // The stale literal reference for the skipped managed key is dropped...
      expect(envFile).not.toContain("LLM_API_KEY");
      expect(envFile).not.toContain("$SECRET_FROM_SHELL");
      // ...while operator-only secrets (never in state-dir .env) are preserved.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    });
  });

  it("removes a stale literal reference after the state-dir .env line is removed (#88274)", async () => {
    await withStageFixture(async ({ env, envFilePath }) => {
      await fs.writeFile(
        envFilePath,
        ["LLM_API_KEY=$SECRET_FROM_SHELL", "OPENROUTER_API_KEY=or-operator-key"].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      mockSystemctlStatusOk();

      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));

      const envFile = await fs.readFile(envFilePath, "utf8");
      expect(envFile).not.toContain("LLM_API_KEY");
      expect(envFile).not.toContain("$SECRET_FROM_SHELL");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
    });
  });

  it("keeps an operator secret that merely shares a name absent from state-dir .env (#88274)", async () => {
    await withStageFixture(async ({ env, stateDir, envFilePath }) => {
      // Operator-managed env file holds two secrets; neither is in state-dir .env.
      await fs.writeFile(
        envFilePath,
        [
          "ANTHROPIC_API_KEY=sk-ant-operator-secret",
          "OPENROUTER_API_KEY=or-operator-key",
          "LOWERCASE_LITERAL_API_KEY=$ecret123",
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      // State-dir .env only skips an unrelated key (LLM_API_KEY). Operator keys must
      // not be treated as stale just because they are absent from the staged env.
      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=${UNRESOLVED}\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService(gatewayPortSystemdServiceFixture(env, "18789"));

      const envFile = await fs.readFile(envFilePath, "utf8");
      expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).toContain('LOWERCASE_LITERAL_API_KEY="\\$ecret123"');
      expect(envFile).not.toContain("LLM_API_KEY");
    });
  });
});

describe("systemd service install and uninstall", () => {
  async function withNodeSystemdFixture(
    run: (context: {
      env: Record<string, string>;
      unitPath: string;
      nodeEnvFilePath: string;
    }) => Promise<void>,
  ): Promise<void> {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
      OPENCLAW_SERVICE_KIND: "node",
    };
    const unitPath = resolveSystemdUnitPath(env);
    const nodeEnvFilePath = path.join(stateDir, "node.systemd.env");

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, unitPath, nodeEnvFilePath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
    vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (env) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${env.OPENCLAW_SYSTEMD_UNIT ?? "openclaw-gateway-work"}.service not found.`,
    }));
  });

  it("activates the OPENCLAW_SYSTEMD_UNIT override during install", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath }) => {
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
        .mockImplementationOnce(systemctlUserSuccess("enable", NODE_SERVICE))
        .mockImplementationOnce(systemctlUserSuccess("restart", NODE_SERVICE));

      await installSystemdService(
        nodeSystemdServiceFixture(env, {
          description: "OpenClaw Node Host",
          environment: {
            OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
          },
        }),
      );

      const unit = await fs.readFile(unitPath, "utf8");
      expect(unitPath).toMatch(/openclaw-node\.service$/);
      expect(unit).toContain("Description=OpenClaw Node Host");
      expect(unit).toContain("openclaw node run");
      expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION");
      expect(execFileMock).toHaveBeenCalledTimes(4);
    });
  });

  it.each([
    {
      name: "an equal-valued launcher override",
      directive: "ExecStart=/usr/bin/openclaw node run",
      shouldWarn: true,
    },
    {
      name: "an environment-only override",
      directive: "Environment=NODE_COMPILE_CACHE=/tmp/cache",
      shouldWarn: false,
    },
  ])(
    "warns after installation only when $name controls the effective launcher",
    async ({ directive, shouldWarn }) => {
      await withNodeSystemdFixture(async ({ env, unitPath }) => {
        const dropInPath = path.join(`${unitPath}.d`, "operator.conf");
        await fs.mkdir(path.dirname(dropInPath), { recursive: true });
        await fs.writeFile(dropInPath, `[Service]\n${directive}\n`);
        await fs.writeFile(unitPath, "[Service]\nExecStart=/usr/bin/openclaw node run\n");
        mockSystemdManagerSnapshot({
          programArguments: ["/usr/bin/openclaw", "node", "run"],
          workingDirectory: "/tmp",
          environment: ["OPENCLAW_SYSTEMD_UNIT=openclaw-node"],
          fragmentPath: unitPath,
          dropInPaths: [dropInPath],
        });
        const managerQuery = execFileMock.getMockImplementation();
        execFileMock.mockImplementation((command, args, options, callback) => {
          if (command === "systemctl") {
            callback(null, "", "");
            return;
          }
          managerQuery?.(command, args, options, callback);
        });
        const warn = vi.fn();

        await installSystemdService(
          nodeSystemdServiceFixture(env, {
            warn,
            environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-node" },
          }),
        );

        if (shouldWarn) {
          expect(warn).toHaveBeenCalledWith(
            "Systemd drop-in overrides the managed service command or working directory; inspect, update, or remove the drop-in because reinstalling the base unit does not change the effective launcher.",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("retries enable after reloading again when systemd cannot see the written unit yet", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
        .mockImplementationOnce(
          systemctlUserResult(
            [
              createExecFileError("enable failed"),
              "",
              "Unit file openclaw-node.service does not exist.",
            ],
            "enable",
            NODE_SERVICE,
          ),
        )
        .mockImplementationOnce(systemctlUserSuccess("daemon-reload"))
        .mockImplementationOnce(systemctlUserSuccess("enable", NODE_SERVICE))
        .mockImplementationOnce(systemctlUserSuccess("restart", NODE_SERVICE));

      await installSystemdService(
        nodeSystemdServiceFixture(env, {
          environment: {
            OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
          },
        }),
      );

      expect(execFileMock).toHaveBeenCalledTimes(6);
    });
  });

  it.each([
    { action: "enable", termination: "timeout" },
    { action: "restart", termination: "signal" },
  ] as const)(
    "does not retry an interrupted $action reporting a missing unit ($termination)",
    async ({ action, termination }) => {
      await withNodeSystemdFixture(async ({ env }) => {
        execFileMock
          .mockImplementation(execFileSuccess())
          .mockImplementationOnce(systemctlUserSuccess("status"))
          .mockImplementationOnce(systemctlUserSuccess("daemon-reload"));
        if (action === "restart") {
          execFileMock.mockImplementationOnce(systemctlUserSuccess("enable", NODE_SERVICE));
        }
        execFileMock.mockImplementationOnce(
          systemctlUserResult(
            [
              createExecFileError(`${action} interrupted`, { termination }),
              "",
              "Unit file openclaw-node.service does not exist.",
            ],
            action,
            NODE_SERVICE,
          ),
        );

        await expect(
          installSystemdService(
            nodeSystemdServiceFixture(env, {
              environment: { OPENCLAW_SYSTEMD_UNIT: "openclaw-node" },
            }),
          ),
        ).rejects.toThrow(`systemctl ${action} failed:`);
        expect(execFileMock.mock.calls.map(([, args]) => args[1])).toEqual([
          "status",
          "daemon-reload",
          ...(action === "restart" ? ["enable"] : []),
          action,
        ]);
      });
    },
  );

  it("falls back to machine user scope when install activation hits a no-medium user bus failure", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      const installEnv = { ...env, USER: "debian" };
      mockNodeInstallNoMediumFailure("debian");

      await installSystemdService(
        nodeSystemdServiceFixture(installEnv, {
          environment: {
            OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
          },
        }),
      );

      expect(execFileMock).toHaveBeenCalledTimes(5);
    });
  });

  it("uses the sudo-u target user for install activation machine-scope retry", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      mockEffectiveUid(process.getuid?.() ?? 1000);
      const installEnv = { ...env, USER: "openclaw", SUDO_USER: "admin" };
      mockNodeInstallNoMediumFailure("openclaw");

      await installSystemdService(
        nodeSystemdServiceFixture(installEnv, {
          environment: {
            OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
          },
        }),
      );

      expect(execFileMock).toHaveBeenCalledTimes(5);
    });
  });

  it("surfaces install activation user-bus failures as systemd unavailable errors", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      vi.spyOn(os, "userInfo").mockImplementation(() => {
        throw new Error("no user info");
      });
      mockNodeInstallNoMediumFailure();

      await expect(
        installSystemdService({
          env,
          stdout: createWritableStreamMock().stdout,
          programArguments: ["/usr/bin/openclaw", "node", "run"],
          workingDirectory: "/tmp",
          environment: {
            OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
          },
        }),
      ).rejects.toThrow("systemctl --user unavailable: Failed to connect to bus: No medium found");

      expect(execFileMock).toHaveBeenCalledTimes(3);
    });
  });

  it.each([
    "Access denied",
    "Unit openclaw-node.service is not loaded properly: Invalid argument.",
    "Failed to disable unit: Access denied.\nUnit openclaw-node.service is not active.",
    "Unit is not loaded.",
    "Unit inactive.",
    "Unit unrelated.service is not active.",
  ])("refuses to remove the unit when systemctl disable fails: %s", async (detail) => {
    await withNodeSystemdFixture(async ({ env, unitPath, nodeEnvFilePath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");
      await fs.writeFile(nodeEnvFilePath, "OPENCLAW_GATEWAY_TOKEN=preserved-token\n", "utf8");
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(
          systemctlUserResult(
            [createExecFileError(detail), "", detail],
            "disable",
            "--now",
            NODE_SERVICE,
          ),
        );

      const { stdout } = createWritableStreamMock();

      await expect(uninstallSystemdService({ env, stdout })).rejects.toThrow(
        `systemctl disable failed: ${detail}`,
      );
      await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
      await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toContain("preserved-token");
    });
  });

  it.each([
    "Unit file openclaw-node.service does not exist.",
    "Failed to disable unit: Unit file openclaw-node.service does not exist.",
    "Unit openclaw-node.service could not be found.",
    "Failed to stop openclaw-node.service: Unit openclaw-node.service not loaded.",
    "Failed to stop openclaw-node.service: Unit openclaw-node.service is not active.",
  ])("keeps missing or inactive systemd unit removal idempotent: %s", async (detail) => {
    await withNodeSystemdFixture(async ({ env }) => {
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(
          systemctlUserResult(
            [createExecFileError(detail), "", detail],
            "disable",
            "--now",
            NODE_SERVICE,
          ),
        );

      const { write, stdout } = createWritableStreamMock();

      await expect(uninstallSystemdService({ env, stdout })).resolves.toBeUndefined();
      expect(requireFirstWrite(write)).toContain("Systemd service not found");
    });
  });

  it("disables the OPENCLAW_SYSTEMD_UNIT override during uninstall", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath, nodeEnvFilePath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");
      await fs.writeFile(`${unitPath}.bak`, "[Unit]\nDescription=Previous OpenClaw Node\n");
      await fs.writeFile(
        nodeEnvFilePath,
        [
          "OPENCLAW_GATEWAY_TOKEN=stale-node-token",
          "OPENCLAW_GATEWAY_PASSWORD=stale-password",
          "OPENROUTER_API_KEY=operator-key",
          "LLM_API_KEY=$SECRET_FROM_SHELL",
          "LITERAL_API_KEY=\\$SECRET_FROM_SHELL",
          "SINGLE_QUOTED_LITERAL_API_KEY='$SECRET_FROM_SHELL'",
          'DOUBLE_QUOTED_LITERAL_API_KEY="$SECRET_FROM_SHELL"',
        ].join("\n") + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", NODE_SERVICE));

      const { write, stdout } = createWritableStreamMock();
      await uninstallSystemdService({ env, stdout });

      let accessError: NodeJS.ErrnoException | undefined;
      try {
        await fs.access(unitPath);
      } catch (error) {
        accessError = error as NodeJS.ErrnoException;
      }
      expect(accessError?.code).toBe("ENOENT");
      await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(
        [
          "OPENROUTER_API_KEY=operator-key",
          'LITERAL_API_KEY="\\$SECRET_FROM_SHELL"',
          'SINGLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"',
          'DOUBLE_QUOTED_LITERAL_API_KEY="\\$SECRET_FROM_SHELL"',
        ].join("\n") + "\n",
      );
      expect(requireFirstWrite(write)).toContain("Removed systemd service");
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });

  it("removes a password-only node environment file during uninstall", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath, nodeEnvFilePath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");
      await fs.writeFile(nodeEnvFilePath, "OPENCLAW_GATEWAY_PASSWORD=stale-password\n", {
        encoding: "utf8",
        mode: 0o600,
      });

      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", NODE_SERVICE));

      const { stdout } = createWritableStreamMock();
      await uninstallSystemdService({ env, stdout });

      await expect(fs.access(nodeEnvFilePath)).rejects.toThrow();
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });

  it("preserves node env file values when unit removal fails during uninstall", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath, nodeEnvFilePath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");
      await fs.writeFile(`${unitPath}.bak`, "[Unit]\nDescription=Previous OpenClaw Node\n");
      await fs.writeFile(
        nodeEnvFilePath,
        "OPENCLAW_GATEWAY_TOKEN=stale-node-token\nOPENROUTER_API_KEY=operator-key\n",
        { encoding: "utf8", mode: 0o600 },
      );

      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", NODE_SERVICE));

      const unlinkError = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      unlinkError.code = "EACCES";
      vi.spyOn(fs, "unlink").mockRejectedValueOnce(unlinkError);

      const { stdout } = createWritableStreamMock();
      await expect(uninstallSystemdService({ env, stdout })).rejects.toThrow(
        "EACCES: permission denied",
      );

      await expect(fs.readFile(unitPath, "utf8")).resolves.toContain("OpenClaw Node");
      await expect(fs.readFile(`${unitPath}.bak`, "utf8")).resolves.toContain(
        "Previous OpenClaw Node",
      );
      await expect(fs.readFile(nodeEnvFilePath, "utf8")).resolves.toBe(
        "OPENCLAW_GATEWAY_TOKEN=stale-node-token\nOPENROUTER_API_KEY=operator-key\n",
      );
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("isSystemUnitActiveAndEnabled", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns true only when the system unit is both running and boot-enabled", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        expect(args).toEqual(["is-enabled", GATEWAY_SERVICE]);
        cb(null, "enabled\n", "");
      });
    await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(true);
  });

  it("returns false for an enabled unit that is not running", async () => {
    // Deleting the user unit here would leave no gateway until the next boot.
    execFileMock.mockImplementationOnce(
      execFileResult(createExecFileError("inactive", { code: 3 }), "", ""),
    );
    await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns false for a running unit that is not enabled at boot", async () => {
    // Deleting the user unit here would leave no gateway after a reboot.
    execFileMock
      .mockImplementationOnce(execFileResult(null, "", ""))
      .mockImplementationOnce(execFileResult(createExecFileError("disabled", { code: 1 }), "", ""));
    await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(false);
  });

  it.each([
    ["unavailable", { code: "ENOENT" }],
    ["bus query failed", { code: 1 }],
    ["terminated", { code: 1, termination: "signal" }],
    ["timed out", { code: 3, termination: "timeout" }],
  ] satisfies [string, Pick<ExecFileError, "code" | "termination">][])(
    "does not adopt the system unit when its activity is unknown: %s",
    async (detail, options) => {
      execFileMock.mockImplementation(
        execFileResult(createExecFileError(detail, options), "", detail),
      );
      await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(false);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    },
  );

  // systemctl(1) Table 3: these all exit 0 but none survive a reboot as an
  // enabled unit, so none may authorize deleting the user-scope unit.
  it.each(["enabled-runtime", "static", "indirect", "generated", "alias", "transient"])(
    "returns false for the non-persistent is-enabled state %s",
    async (state) => {
      execFileMock
        .mockImplementationOnce(execFileResult(null, "", ""))
        .mockImplementationOnce(execFileResult(null, `${state}\n`, ""));
      await expect(isSystemUnitActiveAndEnabled({}, GATEWAY_SERVICE)).resolves.toBe(false);
    },
  );
});

describe("uninstallLegacySystemdUnits", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it.each(["exit", "signal"] as const)(
    "preserves a legacy unit file when disable fails after status %s",
    async (termination) => {
      const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-unit-"));
      const env = { HOME: path.join(tempHomeRoot, "home") };
      const unitPath = path.join(
        env.HOME,
        ".config",
        "systemd",
        "user",
        "clawdbot-gateway.service",
      );
      try {
        await fs.mkdir(path.dirname(unitPath), { recursive: true });
        await fs.writeFile(unitPath, "[Unit]\nDescription=Clawdbot Gateway\n", "utf8");
        await fs.writeFile(`${unitPath}.bak`, "[Unit]\nDescription=Previous Clawdbot Gateway\n");
        execFileMock.mockImplementation((_command, args, _options, callback) => {
          if (args[1] === "status") {
            callback(
              termination === "signal"
                ? createExecFileError("status interrupted", { termination })
                : null,
              "",
              "",
            );
          } else if (args[1] === "is-enabled") {
            callback(null, "enabled\n", "");
          } else {
            assertUserSystemctlArgs(args, "disable", "--now", "clawdbot-gateway.service");
            callback(createExecFileError("permission denied"), "", "Permission denied");
          }
        });

        const { stdout } = createWritableStreamMock();
        await expect(uninstallLegacySystemdUnits({ env, stdout })).rejects.toThrow(
          "systemctl disable failed: Permission denied",
        );
        await expect(fs.access(unitPath)).resolves.toBeUndefined();
        await expect(fs.access(`${unitPath}.bak`)).resolves.toBeUndefined();
      } finally {
        await fs.rm(tempHomeRoot, { recursive: true, force: true });
      }
    },
  );

  it("discovers and removes an orphaned legacy backup", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-backup-"));
    const env = { HOME: path.join(tempHomeRoot, "home") };
    const backupPath = path.join(
      env.HOME,
      ".config",
      "systemd",
      "user",
      "clawdbot-gateway.service.bak",
    );
    try {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.writeFile(backupPath, "Environment=OPENCLAW_GATEWAY_TOKEN=legacy-token\n");
      execFileMock.mockImplementation(execFileSuccess());

      await uninstallLegacySystemdUnits({ env, stdout: createWritableStreamMock().stdout });

      await expect(fs.access(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });
});

describe("uninstallUserSystemdGatewayUnit", () => {
  async function withUserUnitFixture(
    run: (context: { env: Record<string, string>; unitPath: string }) => Promise<void>,
  ): Promise<void> {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-user-unit-"));
    const home = path.join(tempHomeRoot, "home");
    const env = { HOME: home };
    const unitPath = resolveSystemdUnitPath(env);
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await run({ env, unitPath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("disables and removes the user-scope unit when systemctl is available", async () => {
    await withUserUnitFixture(async ({ env, unitPath }) => {
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      await fs.writeFile(`${unitPath}.bak`, "[Unit]\nDescription=Previous gateway\n", "utf8");
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", GATEWAY_SERVICE))
        // A deleted unit stays loaded until the manager reloads.
        .mockImplementationOnce(systemctlUserSuccess("daemon-reload"));

      const { write, stdout } = createWritableStreamMock();
      const result = await uninstallUserSystemdGatewayUnit({ env, stdout });

      expect(result.removed).toBe(true);
      expect(result.disabled).toBe(true);
      expect(result.unitName).toBe(GATEWAY_SERVICE);
      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(requireFirstWrite(write)).toContain("Removed user-scope systemd service");
    });
  });

  it("reports removed:false without throwing when the unit file is already absent", async () => {
    await withUserUnitFixture(async ({ env, unitPath }) => {
      await fs.writeFile(`${unitPath}.bak`, "Environment=OPENCLAW_GATEWAY_TOKEN=orphaned-token\n");
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", GATEWAY_SERVICE));

      const { write, stdout } = createWritableStreamMock();
      const result = await uninstallUserSystemdGatewayUnit({ env, stdout });

      expect(result.removed).toBe(false);
      await expect(fs.access(`${unitPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      expect(requireFirstWrite(write)).toContain("User-scope systemd unit not found");
    });
  });

  it("removes the unit file only when systemctl is unavailable", async () => {
    await withUserUnitFixture(async ({ env, unitPath }) => {
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      execFileMock.mockImplementation(
        execFileResult(createExecFileError("spawn systemctl ENOENT", { code: "ENOENT" }), "", ""),
      );

      const { write, stdout } = createWritableStreamMock();
      const result = await uninstallUserSystemdGatewayUnit({ env, stdout });

      expect(result.removed).toBe(true);
      // File-only removal cannot evict a loaded unit, so callers must not treat
      // this as a resolved conflict.
      expect(result.disabled).toBe(false);
      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
      const writes = write.mock.calls.map((call) => String(call[0])).join("");
      expect(writes).toContain("systemctl unavailable; removing unit file only");
    });
  });

  it.each(["exit", "signal"] as const)(
    "preserves the unit file when disable fails after status %s",
    async (termination) => {
      await withUserUnitFixture(async ({ env, unitPath }) => {
        await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
        execFileMock
          .mockImplementationOnce(
            systemctlUserResult(
              [
                termination === "signal"
                  ? createExecFileError("status interrupted", { termination })
                  : null,
                "",
                "",
              ],
              "status",
            ),
          )
          .mockImplementationOnce(
            systemctlUserResult(
              [createExecFileError("permission denied", { code: 1 }), "", "Permission denied"],
              "disable",
              "--now",
              GATEWAY_SERVICE,
            ),
          );

        const { stdout } = createWritableStreamMock();
        await expect(uninstallUserSystemdGatewayUnit({ env, stdout })).rejects.toThrow(
          "systemctl disable failed: Permission denied",
        );
        await expect(fs.access(unitPath)).resolves.toBeUndefined();
        expect(execFileMock).toHaveBeenCalledTimes(2);
      });
    },
  );

  it("surfaces daemon-reload failure after removing the disabled unit", async () => {
    await withUserUnitFixture(async ({ env, unitPath }) => {
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Gateway\n", "utf8");
      execFileMock
        .mockImplementationOnce(systemctlUserSuccess("status"))
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", GATEWAY_SERVICE))
        .mockImplementationOnce(
          systemctlUserResult(
            [createExecFileError("bus unavailable", { code: 1 }), "", "Bus unavailable"],
            "daemon-reload",
          ),
        );

      const { stdout } = createWritableStreamMock();
      await expect(uninstallUserSystemdGatewayUnit({ env, stdout })).rejects.toThrow(
        "systemctl daemon-reload failed: Bus unavailable",
      );
      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("systemd service control", () => {
  const assertMachineRestartArgs = (args: string[]) => {
    assertMachineUserSystemctlArgs(args, "debian", "restart", GATEWAY_SERVICE);
  };

  beforeEach(() => {
    execFileMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
  });

  it("refuses to start an existing user unit when same-name system ownership is present", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      if (pathLikeToString(target).includes("/.config/systemd/user/")) {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(
      new Error("same-name system ownership"),
    );
    execFileMock.mockImplementationOnce(execFileSuccess());

    await expect(
      startSystemdService({
        stdout: createWritableStreamMock().stdout,
        env: { HOME: TEST_MANAGED_HOME },
      }),
    ).rejects.toThrow("same-name system ownership");

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("starts the resolved user unit and ignores audit observer failures", async () => {
    const sequence: string[] = [];
    execFileMock
      .mockImplementationOnce(execFileSuccess())
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "reset-failed", GATEWAY_SERVICE);
        sequence.push(args[1] ?? "");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "start", GATEWAY_SERVICE);
        sequence.push(args[1] ?? "");
        cb(null, "", "");
      });
    const write = vi.fn();
    const onMutation = vi.fn(() => {
      throw new Error("audit failed");
    });

    await expect(
      startSystemdService({
        stdout: createWritableStreamMock(write).stdout,
        env: {},
        onMutation,
      }),
    ).resolves.toBeUndefined();

    expect(sequence).toEqual(["reset-failed", "start"]);
    expect(onMutation).toHaveBeenCalledWith({ mode: "systemctl-start" });
    expect(
      expectDefined(onMutation.mock.invocationCallOrder[0], "start audit call order"),
    ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
    expect(requireFirstWrite(write)).toContain("Started systemd service");
  });

  it("still starts when reset-failed cannot resolve an unloaded user unit", async () => {
    const sequence: string[] = [];
    execFileMock
      .mockImplementationOnce(execFileSuccess())
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "reset-failed", GATEWAY_SERVICE);
        sequence.push(args[1] ?? "");
        cb(
          createExecFileError("unit not loaded", {
            stderr: `Unit ${GATEWAY_SERVICE} not loaded.`,
          }),
          "",
          `Unit ${GATEWAY_SERVICE} not loaded.`,
        );
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "start", GATEWAY_SERVICE);
        sequence.push(args[1] ?? "");
        cb(null, "", "");
      });
    const { stdout, write } = createWritableStreamMock();

    await startSystemdService({ stdout, env: {} });

    expect(sequence).toEqual(["reset-failed", "start"]);
    expect(requireFirstWrite(write)).toContain("Started systemd service");
  });

  it("stops the resolved user unit", async () => {
    const sequence: string[] = [];
    execFileMock
      .mockImplementationOnce(execFileSuccess())
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "stop", GATEWAY_SERVICE);
        sequence.push(args[1] ?? "");
        cb(null, "", "");
      });
    const write = vi.fn();
    const onMutation = vi.fn();
    const { stdout } = createWritableStreamMock(write);

    await stopSystemdService({ stdout, env: {}, onMutation });

    expect(sequence).toEqual(["stop"]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(requireFirstWrite(write)).toContain("Stopped systemd service");
    expect(onMutation).toHaveBeenCalledWith({ mode: "systemctl-stop" });
    expect(onMutation.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        write.mock.invocationCallOrder[0],
        "write.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });

  it("audits a successful stop before a later output failure", async () => {
    execFileMock
      .mockImplementationOnce(execFileSuccess())
      .mockImplementationOnce(systemctlUserSuccess("stop", GATEWAY_SERVICE));
    const onMutation = vi.fn();
    const write = vi.fn(() => {
      throw new Error("output failed");
    });
    const { stdout } = createWritableStreamMock(write);

    await expect(stopSystemdService({ stdout, env: {}, onMutation })).rejects.toThrow(
      "output failed",
    );

    expect(onMutation).toHaveBeenCalledWith({ mode: "systemctl-stop" });
  });

  it("allows stop when systemd status is degraded but available", async () => {
    execFileMock
      .mockImplementationOnce(
        execFileResult(
          createExecFileError("degraded", { stderr: "degraded\nsome-unit.service failed" }),
          "",
          "",
        ),
      )
      .mockImplementationOnce(systemctlUserSuccess("stop", GATEWAY_SERVICE));

    await stopSystemdService({
      stdout: createWritableStreamMock().stdout,
      env: {},
    });
  });

  it("runs reset-failed before restarting a profile-specific user unit", async () => {
    const restartSequence: string[] = [];
    execFileMock
      .mockImplementationOnce(execFileSuccess())
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "reset-failed", "openclaw-gateway-work.service");
        // args[0] is the "--user" scope flag; the systemctl verb is args[1].
        restartSequence.push(args[1] ?? "");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", "openclaw-gateway-work.service");
        restartSequence.push(args[1] ?? "");
        cb(null, "", "");
      });
    await assertRestartSuccess({ OPENCLAW_PROFILE: "work" });
    // reset-failed must clear any start-limit-hit latch before the restart so a
    // crash-looped unit can recover.
    expect(restartSequence).toEqual(["reset-failed", "restart"]);
  });

  it("surfaces stop failures with systemctl detail", async () => {
    execFileMock
      .mockImplementationOnce(execFileSuccess())
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        const err = new Error("stop failed") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });

    await expect(
      stopSystemdService({
        stdout: createWritableStreamMock().stdout,
        env: {},
      }),
    ).rejects.toThrow("systemctl stop failed: permission denied");
  });

  it("throws the user-bus error before stop when systemd is unavailable", async () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockImplementationOnce(
      execFileResult(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      ),
    );

    await expect(
      stopSystemdService({
        stdout: createWritableStreamMock().stdout,
        env: { USER: "", LOGNAME: "" },
      }),
    ).rejects.toThrow("systemctl --user unavailable: Failed to connect to bus");
  });

  it("targets the sudo caller's user scope when SUDO_USER is set", async () => {
    mockEffectiveUid(0);
    execFileMock
      .mockImplementationOnce(systemctlMachineUserSuccess("debian", "status"))
      .mockImplementationOnce(
        systemctlMachineUserSuccess("debian", "reset-failed", GATEWAY_SERVICE),
      )
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineRestartArgs(args);
        cb(null, "", "");
      });
    await assertRestartSuccess({ SUDO_USER: "debian" });
  });

  it("restarts root user services directly when stale SUDO_USER is paired with root bus environment", async () => {
    mockEffectiveUid(0);
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(systemctlUserSuccess("reset-failed", GATEWAY_SERVICE))
      .mockImplementationOnce(systemctlUserSuccess("restart", GATEWAY_SERVICE));
    await assertRestartSuccess({
      HOME: "/root",
      USER: "root",
      LOGNAME: "root",
      SUDO_USER: "debian",
      XDG_RUNTIME_DIR: "/run/user/0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
    });
  });

  it("keeps direct --user scope when SUDO_USER is root", async () => {
    execFileMock
      .mockImplementationOnce(systemctlUserSuccess("status"))
      .mockImplementationOnce(systemctlUserSuccess("reset-failed", GATEWAY_SERVICE))
      .mockImplementationOnce(systemctlUserSuccess("restart", GATEWAY_SERVICE));
    await assertRestartSuccess({ SUDO_USER: "root", USER: "root" });
  });

  it("falls back to machine user scope for restart when user bus env is missing", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "status");
        const err = createExecFileError("Failed to connect to user scope bus", {
          stderr:
            "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce(systemctlMachineUserSuccess("debian", "status"))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "reset-failed", GATEWAY_SERVICE);
        const err = createExecFileError("Failed to connect to user scope bus", {
          stderr: "Failed to connect to user scope bus",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce(
        systemctlMachineUserSuccess("debian", "reset-failed", GATEWAY_SERVICE),
      )
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
        const err = createExecFileError("Failed to connect to user scope bus", {
          stderr: "Failed to connect to user scope bus",
        });
        cb(err, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineRestartArgs(args);
        cb(null, "", "");
      });
    await assertRestartSuccess({ USER: "debian" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
