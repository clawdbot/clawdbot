import { describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const confirm = vi.fn().mockResolvedValue(true);
const writeConfigFile = vi.fn().mockResolvedValue(undefined);
const migrateLegacyConfig = vi.fn((raw: unknown) => ({
  config: raw as Record<string, unknown>,
  changes: ["Moved routing.allowFrom → whatsapp.allowFrom."],
}));

const runExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
const runCommandWithTimeout = vi.fn().mockResolvedValue({
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
});

const legacyReadConfigFileSnapshot = vi.fn().mockResolvedValue({
  path: "/tmp/clawdis.json",
  exists: false,
  raw: null,
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
});
const createConfigIO = vi.fn(() => ({
  readConfigFileSnapshot: legacyReadConfigFileSnapshot,
}));

const findLegacyGatewayServices = vi.fn().mockResolvedValue([]);
const uninstallLegacyGatewayServices = vi.fn().mockResolvedValue([]);
const resolveGatewayProgramArguments = vi.fn().mockResolvedValue({
  programArguments: ["node", "cli", "gateway-daemon", "--port", "18789"],
});
const serviceInstall = vi.fn().mockResolvedValue(undefined);
const serviceIsLoaded = vi.fn().mockResolvedValue(false);
const serviceStop = vi.fn().mockResolvedValue(undefined);
const serviceRestart = vi.fn().mockResolvedValue(undefined);
const serviceUninstall = vi.fn().mockResolvedValue(undefined);

vi.mock("@clack/prompts", () => ({
  confirm,
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: () => ({ skills: [] }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    CONFIG_PATH_CLAWDBOT: "/tmp/clawdbot.json",
    createConfigIO,
    readConfigFileSnapshot,
    writeConfigFile,
    migrateLegacyConfig,
  };
});

vi.mock("../daemon/legacy.js", () => ({
  findLegacyGatewayServices,
  uninstallLegacyGatewayServices,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout,
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    install: serviceInstall,
    uninstall: serviceUninstall,
    stop: serviceStop,
    restart: serviceRestart,
    isLoaded: serviceIsLoaded,
    readCommand: vi.fn(),
  }),
}));

vi.mock("../telegram/pairing-store.js", () => ({
  readTelegramAllowFromStore: vi.fn().mockResolvedValue([]),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readProviderAllowFromStore: vi.fn().mockResolvedValue([]),
}));

vi.mock("../telegram/token.js", () => ({
  resolveTelegramToken: vi.fn(() => ({ token: "", source: "none" })),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: () => {},
    error: () => {},
    exit: () => {
      throw new Error("exit");
    },
  },
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveUserPath: (value: string) => value,
    sleep: vi.fn(),
  };
});

vi.mock("./health.js", () => ({
  healthCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: Record<string, unknown>) => cfg,
  DEFAULT_WORKSPACE: "/tmp",
  guardCancel: (value: unknown) => value,
  printWizardHeader: vi.fn(),
}));

describe("doctor", () => {
  it("migrates routing.allowFrom to whatsapp.allowFrom", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: { routing: { allowFrom: ["+15555550123"] } },
      valid: false,
      config: {},
      issues: [
        {
          path: "routing.allowFrom",
          message: "legacy",
        },
      ],
      legacyIssues: [
        {
          path: "routing.allowFrom",
          message: "legacy",
        },
      ],
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    migrateLegacyConfig.mockReturnValue({
      config: { whatsapp: { allowFrom: ["+15555550123"] } },
      changes: ["Moved routing.allowFrom → whatsapp.allowFrom."],
    });

    await doctorCommand(runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect((written.whatsapp as Record<string, unknown>)?.allowFrom).toEqual([
      "+15555550123",
    ]);
    expect(written.routing).toBeUndefined();
  });

  it("migrates legacy Clawdis services", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {},
      issues: [],
      legacyIssues: [],
    });

    findLegacyGatewayServices.mockResolvedValueOnce([
      {
        platform: "darwin",
        label: "com.clawdis.gateway",
        detail: "loaded",
      },
    ]);
    serviceIsLoaded.mockResolvedValueOnce(false);
    serviceInstall.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime);

    expect(uninstallLegacyGatewayServices).toHaveBeenCalledTimes(1);
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("migrates legacy config file", async () => {
    readConfigFileSnapshot
      .mockResolvedValueOnce({
        path: "/tmp/clawdbot.json",
        exists: false,
        raw: null,
        parsed: {},
        valid: true,
        config: {},
        issues: [],
        legacyIssues: [],
      })
      .mockResolvedValueOnce({
        path: "/tmp/clawdbot.json",
        exists: true,
        raw: "{}",
        parsed: {
          gateway: { mode: "local", bind: "loopback" },
          agent: {
            workspace: "/Users/steipete/clawdbot",
            sandbox: {
              workspaceRoot: "/Users/steipete/clawdbot/sandboxes",
              docker: {
                image: "clawdbot-sandbox",
                containerPrefix: "clawdbot-sbx",
              },
            },
          },
        },
        valid: true,
        config: {
          gateway: { mode: "local", bind: "loopback" },
          agent: {
            workspace: "/Users/steipete/clawdbot",
            sandbox: {
              workspaceRoot: "/Users/steipete/clawdbot/sandboxes",
              docker: {
                image: "clawdbot-sandbox",
                containerPrefix: "clawdbot-sbx",
              },
            },
          },
        },
        issues: [],
        legacyIssues: [],
      });

    legacyReadConfigFileSnapshot.mockResolvedValueOnce({
      path: "/Users/steipete/.clawdis/clawdis.json",
      exists: true,
      raw: "{}",
      parsed: {
        gateway: { mode: "local", bind: "loopback" },
        agent: {
          workspace: "/Users/steipete/clawd",
          sandbox: {
            workspaceRoot: "/Users/steipete/clawd/sandboxes",
            docker: {
              image: "clawdis-sandbox",
              containerPrefix: "clawdis-sbx",
            },
          },
        },
      },
      valid: true,
      config: {
        gateway: { mode: "local", bind: "loopback" },
        agent: {
          workspace: "/Users/steipete/clawd",
          sandbox: {
            workspaceRoot: "/Users/steipete/clawd/sandboxes",
            docker: {
              image: "clawdis-sandbox",
              containerPrefix: "clawdis-sbx",
            },
          },
        },
      },
      issues: [],
      legacyIssues: [],
    });

    migrateLegacyConfig.mockReturnValueOnce({
      config: {
        gateway: { mode: "local", bind: "loopback" },
        agent: {
          workspace: "/Users/steipete/clawd",
          sandbox: {
            workspaceRoot: "/Users/steipete/clawd/sandboxes",
            docker: {
              image: "clawdis-sandbox",
              containerPrefix: "clawdis-sbx",
            },
          },
        },
      },
      changes: [],
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime);

    const written = writeConfigFile.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    const agent = written.agent as Record<string, unknown>;
    const sandbox = agent.sandbox as Record<string, unknown>;
    const docker = sandbox.docker as Record<string, unknown>;

    expect(agent.workspace).toBe("/Users/steipete/clawdbot");
    expect(sandbox.workspaceRoot).toBe("/Users/steipete/clawdbot/sandboxes");
    expect(docker.image).toBe("clawdbot-sandbox");
    expect(docker.containerPrefix).toBe("clawdbot-sbx");
  });
  it("falls back to legacy sandbox image when missing", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {
        agent: {
          sandbox: {
            mode: "non-main",
            docker: {
              image: "clawdbot-sandbox-common:bookworm-slim",
            },
          },
        },
      },
      valid: true,
      config: {
        agent: {
          sandbox: {
            mode: "non-main",
            docker: {
              image: "clawdbot-sandbox-common:bookworm-slim",
            },
          },
        },
      },
      issues: [],
      legacyIssues: [],
    });

    runExec.mockImplementation((command: string, args: string[]) => {
      if (command !== "docker") {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (args[0] === "version") {
        return Promise.resolve({ stdout: "1", stderr: "" });
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const image = args[2];
        if (image === "clawdbot-sandbox-common:bookworm-slim") {
          return Promise.reject(new Error("missing"));
        }
        if (image === "clawdis-sandbox-common:bookworm-slim") {
          return Promise.resolve({ stdout: "ok", stderr: "" });
        }
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime);

    const written = writeConfigFile.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    const agent = written.agent as Record<string, unknown>;
    const sandbox = agent.sandbox as Record<string, unknown>;
    const docker = sandbox.docker as Record<string, unknown>;

    expect(docker.image).toBe("clawdis-sandbox-common:bookworm-slim");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
