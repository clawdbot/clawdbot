import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: existsSyncMock,
}));

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessExecFile } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessExecFile(
    Object.assign(execFileMock, {
      __promisify__: vi.fn(),
    }) as typeof import("node:child_process").execFile,
  );
});

import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdExecStart } from "./systemd-unit.js";
import {
  installSystemdService,
  isNonFatalSystemdInstallProbeError,
  isSystemdServiceEnabled,
  isSystemdUnitActive,
  isSystemdUserServiceAvailable,
  parseSystemdShow,
  readSystemdServiceExecStart,
  restartSystemdService,
  resolveSystemdUserUnitPath,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";

type ExecFileError = Error & {
  stderr?: string;
  code?: string | number;
};

const TEST_SERVICE_HOME = "/home/test";
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";
const NODE_SERVICE = "openclaw-node.service";

const createExecFileError = (
  message: string,
  options: { stderr?: string; code?: string | number } = {},
): ExecFileError => {
  const err = new Error(message) as ExecFileError;
  err.code = options.code ?? 1;
  if (options.stderr) {
    err.stderr = options.stderr;
  }
  return err;
};

const createWritableStreamMock = () => {
  const write = vi.fn();
  return {
    write,
    stdout: { write } as unknown as NodeJS.WritableStream,
  };
};

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
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("repairs missing user bus environment when the runtime bus exists", async () => {
    mockEffectiveUid(1000);
    existsSyncMock.mockReturnValue(true);
    execFileMock.mockImplementation((_cmd, args, opts, cb) => {
      assertUserSystemctlArgs(args, "status");
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
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(createExecFileError("degraded", { stderr: "degraded\nsome-unit.service failed" }), "", "");
    });

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
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertMachineUserSystemctlArgs(args, "ai", "status");
      cb(
        createExecFileError("Failed to connect to bus: No such file or directory", {
          stderr: "Failed to connect to bus: No such file or directory",
          code: 1,
        }),
        "",
        "",
      );
    });

    await expect(isSystemdUserServiceAvailable({ SUDO_USER: "ai" })).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not let preserved USER suppress sudo-to-root machine scope", async () => {
    mockEffectiveUid(0);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertMachineUserSystemctlArgs(args, "debian", "status");
      cb(null, "", "");
    });

    await expect(
      isSystemdUserServiceAvailable({
        SUDO_USER: "debian",
        USER: "root-env-stale",
        LOGNAME: "root-env-stale",
      }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not let stale SUDO_USER override a sudo-u target user scope", async () => {
    mockEffectiveUid(1000);
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "status");
      cb(null, "", "");
    });

    await expect(
      isSystemdUserServiceAvailable({ USER: "openclaw", SUDO_USER: "admin" }),
    ).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("isSystemdServiceEnabled", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("returns false when systemctl is not present", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("spawn systemctl EACCES") as Error & { code?: string };
      err.code = "EACCES";
      cb(err, "", "");
    });
    const result = await readManagedServiceEnabled();
    expect(result).toBe(false);
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
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      cb(null, "enabled", "");
    });
    const result = await readManagedServiceEnabled();
    expect(result).toBe(true);
  });

  it("returns false when systemctl reports disabled", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      const err = new Error("disabled") as Error & { code?: number };
      err.code = 1;
      cb(err, "disabled", "");
    });
    const result = await readManagedServiceEnabled();
    expect(result).toBe(false);
  });

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
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
      cb(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      );
    });

    await expect(
      readManagedServiceEnabled({ HOME: TEST_MANAGED_HOME, USER: "", LOGNAME: "" }),
    ).rejects.toThrow("systemctl is-enabled unavailable: Failed to connect to bus");
  });

  it("returns false when both direct and machine-scope is-enabled checks report bus unavailability", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "is-enabled", GATEWAY_SERVICE);
        cb(
          createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
          "",
          "",
        );
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineUserSystemctlArgs(args, "debian", "is-enabled", GATEWAY_SERVICE);
        cb(
          createExecFileError("Failed to connect to user scope bus via local transport", {
            stderr:
              "Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined",
          }),
          "",
          "",
        );
      });

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
        expect(String(args[1])).toMatch(/^[^@]+@$/);
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
  });

  it("checks user-scoped units through the user systemd manager", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "is-active", "--quiet", GATEWAY_SERVICE);
      cb(null, "", "");
    });

    await expect(isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE)).resolves.toBe(
      true,
    );
  });

  it("checks system-scoped units without the user manager", async () => {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      expect(args).toEqual(["is-active", "--quiet", GATEWAY_SERVICE]);
      cb(createExecFileError("inactive", { code: 3 }), "", "");
    });

    await expect(
      isSystemdUnitActive({ HOME: TEST_MANAGED_HOME }, GATEWAY_SERVICE, "system"),
    ).resolves.toBe(false);
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

describe("systemd runtime parsing", () => {
  it("parses active state details", () => {
    const output = [
      "ActiveState=inactive",
      "SubState=dead",
      "MainPID=0",
      "ExecMainStatus=2",
      "ExecMainCode=exited",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "inactive",
      subState: "dead",
      execMainStatus: 2,
      execMainCode: "exited",
    });
  });

  it("rejects pid and exit status values with junk suffixes", () => {
    const output = [
      "ActiveState=inactive",
      "SubState=dead",
      "MainPID=42abc",
      "ExecMainStatus=2ms",
      "ExecMainCode=exited",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "inactive",
      subState: "dead",
      execMainCode: "exited",
    });
  });
});

describe("resolveSystemdUserUnitPath", () => {
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
    expect(resolveSystemdUserUnitPath(env)).toBe(expected);
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
          "OPENCLAW_GATEWAY_PASSWORD=quoted-password", // pragma: allowlist secret
        ].join("\n");
      }
      throw new Error(`unexpected readFile path: ${pathValue}`);
    });

    const command = await readSystemdServiceExecStart({ HOME: "/home/test" });
    expect(command?.environment).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "quoted token",
      OPENCLAW_GATEWAY_PASSWORD: "quoted-password", // pragma: allowlist secret
    });
    expect(command?.environmentValueSources).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
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
    const unitPath = resolveSystemdUserUnitPath(env);
    const envFilePath = path.join(stateDir, "gateway.systemd.env");

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, stateDir, unitPath, envFilePath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  function mockSystemctlStatusOk(): void {
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      assertUserSystemctlArgs(args, "status");
      cb(null, "", "");
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("writes dotenv-backed values to a separate env file and keeps inline env minimal", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        ["OPENCLAW_GATEWAY_TOKEN=dotenv-token", "LLM_API_KEY=dotenv-key"].join("\n"),
        "utf8",
      );

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "dotenv-token",
          LLM_API_KEY: "dotenv-key",
          OPENCLAW_GATEWAY_PORT: "18789",
        },
      });

      const [unit, envFile, envFileStat] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
        fs.stat(envFilePath),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${envFilePath}`);
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_PORT=18789");
      expect(unit).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=dotenv-token");
      expect(unit).not.toContain("Environment=LLM_API_KEY=dotenv-key");
      expect(envFile).toBe("OPENCLAW_GATEWAY_TOKEN=dotenv-token\nLLM_API_KEY=dotenv-key\n");
      expect(envFileStat.mode & 0o777).toBe(0o600);
    });
  });

  it("keeps inline overrides out of the generated env file", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        ["OPENCLAW_GATEWAY_TOKEN=stale-token", "LLM_API_KEY=dotenv-key"].join("\n"),
        "utf8",
      );

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-token",
          LLM_API_KEY: "dotenv-key",
        },
      });

      const [unit, envFile] = await Promise.all([
        fs.readFile(unitPath, "utf8"),
        fs.readFile(envFilePath, "utf8"),
      ]);

      expect(unit).toContain(`EnvironmentFile=-${envFilePath}`);
      expect(unit).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=fresh-token");
      expect(envFile).toBe("LLM_API_KEY=dotenv-key\n");
    });
  });

  it("clears stale inline-managed keys from env file on re-stage (#76860)", async () => {
    await withStageFixture(async ({ env, stateDir, unitPath, envFilePath }) => {
      // Existing env file carries a stale OPENCLAW_GATEWAY_TOKEN that the
      // operator previously wrote there but staging now supplies inline.
      await fs.writeFile(
        envFilePath,
        ["OPENCLAW_GATEWAY_TOKEN=stale-gateway-token", "OPENROUTER_API_KEY=or-operator-key"].join(
          "\n",
        ) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      await fs.writeFile(path.join(stateDir, ".env"), "LLM_API_KEY=dotenv-key\n", "utf8");

      mockSystemctlStatusOk();

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        // Staging manages OPENCLAW_GATEWAY_TOKEN inline; OPENCLAW_SERVICE_MANAGED_ENV_KEYS
        // marks it as an OpenClaw-managed key so the stale env-file copy is cleared.
        environment: {
          OPENCLAW_GATEWAY_TOKEN: "fresh-gateway-token",
          LLM_API_KEY: "dotenv-key",
          OPENROUTER_API_KEY: "or-operator-key",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "OPENCLAW_GATEWAY_TOKEN",
        },
        environmentValueSources: {
          OPENCLAW_GATEWAY_TOKEN: "inline-and-file",
          LLM_API_KEY: "inline",
          OPENROUTER_API_KEY: "file",
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
      // Operator-added key not managed inline must survive.
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).toContain("LLM_API_KEY=dotenv-key");
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

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      });

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

      await stageSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "gateway", "run"],
        workingDirectory: "/tmp",
        environment: { LLM_API_KEY: "new-value" },
      });

      const envFile = await fs.readFile(envFilePath, "utf8");
      // Operator secrets must survive; state-dir key gets updated value.
      expect(envFile).toContain("ANTHROPIC_API_KEY=sk-ant-operator-secret");
      expect(envFile).toContain("OPENROUTER_API_KEY=or-operator-key");
      expect(envFile).toContain("LLM_API_KEY=new-value");
    });
  });
});

describe("systemd service install and uninstall", () => {
  async function withNodeSystemdFixture(
    run: (context: { env: Record<string, string>; unitPath: string }) => Promise<void>,
  ): Promise<void> {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-systemd-"));
    const home = path.join(tempHomeRoot, "home");
    const stateDir = path.join(home, ".openclaw");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
    };
    const unitPath = resolveSystemdUserUnitPath(env);

    try {
      await fs.mkdir(stateDir, { recursive: true });
      await run({ env, unitPath });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it("activates the OPENCLAW_SYSTEMD_UNIT override during install", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath }) => {
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      const unit = await fs.readFile(unitPath, "utf8");
      expect(unitPath).toMatch(/openclaw-node\.service$/);
      expect(unit).toContain("openclaw node run");
      expect(execFileMock).toHaveBeenCalledTimes(4);
    });
  });

  it("retries enable after reloading again when systemd cannot see the written unit yet", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("enable failed"),
            "",
            "Unit file openclaw-node.service does not exist.",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      expect(execFileMock).toHaveBeenCalledTimes(6);
    });
  });

  it("falls back to machine user scope when install activation hits a no-medium user bus failure", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      const installEnv = { ...env, USER: "debian" };
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus: No medium found", {
              stderr: "Failed to connect to bus: No medium found",
            }),
            "",
            "",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "debian", "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env: installEnv,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      expect(execFileMock).toHaveBeenCalledTimes(5);
    });
  });

  it("uses the sudo-u target user for install activation machine-scope retry", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      const installEnv = { ...env, USER: "openclaw", SUDO_USER: "admin" };
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus: No medium found", {
              stderr: "Failed to connect to bus: No medium found",
            }),
            "",
            "",
          );
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertMachineUserSystemctlArgs(args, "openclaw", "enable", NODE_SERVICE);
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "restart", NODE_SERVICE);
          cb(null, "", "");
        });

      await installSystemdService({
        env: installEnv,
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        programArguments: ["/usr/bin/openclaw", "node", "run"],
        workingDirectory: "/tmp",
        environment: {
          OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
        },
      });

      expect(execFileMock).toHaveBeenCalledTimes(5);
    });
  });

  it("surfaces install activation user-bus failures as systemd unavailable errors", async () => {
    await withNodeSystemdFixture(async ({ env }) => {
      vi.spyOn(os, "userInfo").mockImplementation(() => {
        throw new Error("no user info");
      });
      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "daemon-reload");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "enable", NODE_SERVICE);
          cb(
            createExecFileError("Failed to connect to bus: No medium found", {
              stderr: "Failed to connect to bus: No medium found",
            }),
            "",
            "",
          );
        });

      await expect(
        installSystemdService({
          env,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
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

  it("disables the OPENCLAW_SYSTEMD_UNIT override during uninstall", async () => {
    await withNodeSystemdFixture(async ({ env, unitPath }) => {
      await fs.mkdir(path.dirname(unitPath), { recursive: true });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Node\n", "utf8");

      execFileMock
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "status");
          cb(null, "", "");
        })
        .mockImplementationOnce((_cmd, args, _opts, cb) => {
          assertUserSystemctlArgs(args, "disable", "--now", NODE_SERVICE);
          cb(null, "", "");
        });

      const { write, stdout } = createWritableStreamMock();
      await uninstallSystemdService({ env, stdout });

      let accessError: NodeJS.ErrnoException | undefined;
      try {
        await fs.access(unitPath);
      } catch (error) {
        accessError = error as NodeJS.ErrnoException;
      }
      expect(accessError?.code).toBe("ENOENT");
      expect(requireFirstWrite(write)).toContain("Removed systemd service");
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("systemd service control", () => {
  const assertMachineRestartArgs = (args: string[]) => {
    assertMachineUserSystemctlArgs(args, "debian", "restart", GATEWAY_SERVICE);
  };

  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("stops the resolved user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "stop", GATEWAY_SERVICE);
        cb(null, "", "");
      });
    const write = vi.fn();
    const stdout = { write } as unknown as NodeJS.WritableStream;

    await stopSystemdService({ stdout, env: {} });

    expect(write).toHaveBeenCalledTimes(1);
    expect(requireFirstWrite(write)).toContain("Stopped systemd service");
  });

  it("allows stop when systemd status is degraded but available", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) =>
        cb(
          createExecFileError("degraded", { stderr: "degraded\nsome-unit.service failed" }),
          "",
          "",
        ),
      )
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "stop", GATEWAY_SERVICE);
        cb(null, "", "");
      });

    await stopSystemdService({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      env: {},
    });
  });

  it("restarts a profile-specific user unit", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", "openclaw-gateway-work.service");
        cb(null, "", "");
      });
    await assertRestartSuccess({ OPENCLAW_PROFILE: "work" });
  });

  it("surfaces stop failures with systemctl detail", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, _args, _opts, cb) => cb(null, "", ""))
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        const err = new Error("stop failed") as Error & { code?: number };
        err.code = 1;
        cb(err, "", "permission denied");
      });

    await expect(
      stopSystemdService({
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        env: {},
      }),
    ).rejects.toThrow("systemctl stop failed: permission denied");
  });

  it("throws the user-bus error before stop when systemd is unavailable", async () => {
    vi.spyOn(os, "userInfo").mockImplementationOnce(() => {
      throw new Error("no user info");
    });
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(
        createExecFileError("Failed to connect to bus", { stderr: "Failed to connect to bus" }),
        "",
        "",
      );
    });

    await expect(
      stopSystemdService({
        stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        env: { USER: "", LOGNAME: "" },
      }),
    ).rejects.toThrow("systemctl --user unavailable: Failed to connect to bus");
  });

  it("targets the sudo caller's user scope when SUDO_USER is set", async () => {
    mockEffectiveUid(0);
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineUserSystemctlArgs(args, "debian", "status");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineRestartArgs(args);
        cb(null, "", "");
      });
    await assertRestartSuccess({ SUDO_USER: "debian" });
  });

  it("keeps direct --user scope when SUDO_USER is root", async () => {
    execFileMock
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "status");
        cb(null, "", "");
      })
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertUserSystemctlArgs(args, "restart", GATEWAY_SERVICE);
        cb(null, "", "");
      });
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
      .mockImplementationOnce((_cmd, args, _opts, cb) => {
        assertMachineUserSystemctlArgs(args, "debian", "status");
        cb(null, "", "");
      })
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
