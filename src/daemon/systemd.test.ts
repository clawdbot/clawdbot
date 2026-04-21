import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessExecFile } = await import("../../test/helpers/node-builtin-mocks.js");
  return mockNodeChildProcessExecFile(
    Object.assign(execFileMock, {
      __promisify__: vi.fn(),
    }) as typeof import("node:child_process").execFile,
  );
});

import { splitArgsPreservingQuotes } from "./arg-split.js";
import { parseSystemdExecStart } from "./systemd-unit.js";
import {
  isNonFatalSystemdInstallProbeError,
  isSystemdServiceEnabled,
  isSystemdUserServiceAvailable,
  parseSystemdShow,
  readSystemdServiceExecStart,
  restartSystemdService,
  resolveSystemdUserUnitPath,
  stageSystemdService,
  stopSystemdService,
} from "./systemd.js";

type ExecFileError = Error & {
  stderr?: string;
  code?: string | number;
};

const TEST_SERVICE_HOME = "/home/test";
const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";
const GATEWAY_SERVICE = "openclaw-gateway.service";

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
  expect(String(write.mock.calls[0]?.[0])).toContain("Restarted systemd service");
};

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
    expect(command?.environmentValueSources?.OPENCLAW_GATEWAY_TOKEN).toBe("file");
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
    expect(String(write.mock.calls[0]?.[0])).toContain("Stopped systemd service");
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
