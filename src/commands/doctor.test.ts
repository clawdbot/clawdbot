import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalIsTTY: boolean | undefined;
let originalStateDir: string | undefined;
let tempStateDir: string | undefined;

function setStdinTty(value: boolean | undefined) {
  try {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  } catch {
    // ignore
  }
}

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinTty(true);
  originalStateDir = process.env.CLAWDBOT_STATE_DIR;
  tempStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawdbot-doctor-state-"),
  );
  process.env.CLAWDBOT_STATE_DIR = tempStateDir;
  fs.mkdirSync(path.join(tempStateDir, "agents", "main", "sessions"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tempStateDir, "credentials"), { recursive: true });
});

afterEach(() => {
  setStdinTty(originalIsTTY);
  if (originalStateDir === undefined) {
    delete process.env.CLAWDBOT_STATE_DIR;
  } else {
    process.env.CLAWDBOT_STATE_DIR = originalStateDir;
  }
  if (tempStateDir) {
    fs.rmSync(tempStateDir, { recursive: true, force: true });
    tempStateDir = undefined;
  }
});

const readConfigFileSnapshot = vi.fn();
const confirm = vi.fn().mockResolvedValue(true);
const select = vi.fn().mockResolvedValue("node");
const note = vi.fn();
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

const ensureAuthProfileStore = vi
  .fn()
  .mockReturnValue({ version: 1, profiles: {} });

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
const findExtraGatewayServices = vi.fn().mockResolvedValue([]);
const renderGatewayServiceCleanupHints = vi.fn().mockReturnValue(["cleanup"]);
const resolveGatewayProgramArguments = vi.fn().mockResolvedValue({
  programArguments: ["node", "cli", "gateway", "--port", "18789"],
});
const serviceInstall = vi.fn().mockResolvedValue(undefined);
const serviceIsLoaded = vi.fn().mockResolvedValue(false);
const serviceStop = vi.fn().mockResolvedValue(undefined);
const serviceRestart = vi.fn().mockResolvedValue(undefined);
const serviceUninstall = vi.fn().mockResolvedValue(undefined);
const callGateway = vi.fn().mockRejectedValue(new Error("gateway closed"));

vi.mock("@clack/prompts", () => ({
  confirm,
  intro: vi.fn(),
  note,
  outro: vi.fn(),
  select,
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

vi.mock("../daemon/inspect.js", () => ({
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments,
}));

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    ...actual,
    callGateway,
  };
});

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout,
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureAuthProfileStore,
  };
});

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
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
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

vi.mock("./doctor-state-migrations.js", () => ({
  detectLegacyStateMigrations: vi.fn().mockResolvedValue({
    targetAgentId: "main",
    targetMainKey: "main",
    stateDir: "/tmp/state",
    oauthDir: "/tmp/oauth",
    sessions: {
      legacyDir: "/tmp/state/sessions",
      legacyStorePath: "/tmp/state/sessions/sessions.json",
      targetDir: "/tmp/state/agents/main/sessions",
      targetStorePath: "/tmp/state/agents/main/sessions/sessions.json",
      hasLegacy: false,
    },
    agentDir: {
      legacyDir: "/tmp/state/agent",
      targetDir: "/tmp/state/agents/main/agent",
      hasLegacy: false,
    },
    whatsappAuth: {
      legacyDir: "/tmp/oauth",
      targetDir: "/tmp/oauth/whatsapp/default",
      hasLegacy: false,
    },
    preview: [],
  }),
  runLegacyStateMigrations: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
}));

describe("doctor", () => {
  it(
    "migrates routing.allowFrom to whatsapp.allowFrom",
    { timeout: 15_000 },
    async () => {
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

      await doctorCommand(runtime, { nonInteractive: true });

      expect(writeConfigFile).toHaveBeenCalledTimes(1);
      const written = writeConfigFile.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect((written.whatsapp as Record<string, unknown>)?.allowFrom).toEqual([
        "+15555550123",
      ]);
      expect(written.routing).toBeUndefined();
    },
  );

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
          agents: {
            defaults: {
              workspace: "/Users/steipete/clawd",
              sandbox: {
                workspaceRoot: "/Users/steipete/clawd/sandboxes",
                docker: {
                  image: "clawdbot-sandbox",
                  containerPrefix: "clawdbot-sbx",
                },
              },
            },
          },
        },
        valid: true,
        config: {
          gateway: { mode: "local", bind: "loopback" },
          agents: {
            defaults: {
              workspace: "/Users/steipete/clawd",
              sandbox: {
                workspaceRoot: "/Users/steipete/clawd/sandboxes",
                docker: {
                  image: "clawdbot-sandbox",
                  containerPrefix: "clawdbot-sbx",
                },
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
        agents: {
          defaults: {
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
    const agents = written.agents as Record<string, unknown>;
    const defaults = agents.defaults as Record<string, unknown>;
    const sandbox = defaults.sandbox as Record<string, unknown>;
    const docker = sandbox.docker as Record<string, unknown>;

    expect(defaults.workspace).toBe("/Users/steipete/clawd");
    expect(sandbox.workspaceRoot).toBe("/Users/steipete/clawd/sandboxes");
    expect(docker.image).toBe("clawdbot-sandbox");
    expect(docker.containerPrefix).toBe("clawdbot-sbx");
  });

  it("warns when per-agent sandbox docker/browser/prune overrides are ignored under shared scope", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "shared",
            },
          },
          list: [
            {
              id: "work",
              workspace: "~/clawd-work",
              sandbox: {
                mode: "all",
                scope: "shared",
                docker: {
                  setupCommand: "echo work",
                },
              },
            },
          ],
        },
      },
      issues: [],
      legacyIssues: [],
    });

    note.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime, { nonInteractive: true });

    expect(
      note.mock.calls.some(
        ([message, title]) =>
          title === "Sandbox" &&
          typeof message === "string" &&
          message.includes('agents.list (id "work") sandbox docker') &&
          message.includes('scope resolves to "shared"'),
      ),
    ).toBe(true);
  });

  it("warns when legacy workspace directories exist", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        agents: { defaults: { workspace: "/Users/steipete/clawd" } },
      },
      issues: [],
      legacyIssues: [],
    });

    note.mockClear();
    const homedirSpy = vi
      .spyOn(os, "homedir")
      .mockReturnValue("/Users/steipete");
    const realExists = fs.existsSync;
    const legacyPath = path.join("/Users/steipete", "clawdis");
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((value) => {
      if (value === "/Users/steipete/clawdis" || value === legacyPath)
        return true;
      return realExists(value as never);
    });

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime, { nonInteractive: true });

    expect(
      note.mock.calls.some(
        ([message, title]) =>
          title === "Legacy workspace" &&
          typeof message === "string" &&
          message.includes("clawdis"),
      ),
    ).toBe(true);

    homedirSpy.mockRestore();
    existsSpy.mockRestore();
  });
  it("falls back to legacy sandbox image when missing", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {
        agents: {
          defaults: {
            sandbox: {
              mode: "non-main",
              docker: {
                image: "clawdbot-sandbox-common:bookworm-slim",
              },
            },
          },
        },
      },
      valid: true,
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "non-main",
              docker: {
                image: "clawdbot-sandbox-common:bookworm-slim",
              },
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
    const agents = written.agents as Record<string, unknown>;
    const defaults = agents.defaults as Record<string, unknown>;
    const sandbox = defaults.sandbox as Record<string, unknown>;
    const docker = sandbox.docker as Record<string, unknown>;

    expect(docker.image).toBe("clawdis-sandbox-common:bookworm-slim");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("runs legacy state migrations in non-interactive mode without prompting", async () => {
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

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const { detectLegacyStateMigrations, runLegacyStateMigrations } =
      await import("./doctor-state-migrations.js");
    detectLegacyStateMigrations.mockResolvedValueOnce({
      targetAgentId: "main",
      targetMainKey: "main",
      stateDir: "/tmp/state",
      oauthDir: "/tmp/oauth",
      sessions: {
        legacyDir: "/tmp/state/sessions",
        legacyStorePath: "/tmp/state/sessions/sessions.json",
        targetDir: "/tmp/state/agents/main/sessions",
        targetStorePath: "/tmp/state/agents/main/sessions/sessions.json",
        hasLegacy: true,
      },
      agentDir: {
        legacyDir: "/tmp/state/agent",
        targetDir: "/tmp/state/agents/main/agent",
        hasLegacy: false,
      },
      whatsappAuth: {
        legacyDir: "/tmp/oauth",
        targetDir: "/tmp/oauth/whatsapp/default",
        hasLegacy: false,
      },
      preview: ["- Legacy sessions detected"],
    });
    runLegacyStateMigrations.mockResolvedValueOnce({
      changes: ["migrated"],
      warnings: [],
    });

    confirm.mockClear();

    await doctorCommand(runtime, { nonInteractive: true });

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("runs legacy state migrations in yes mode without prompting", async () => {
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

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const { detectLegacyStateMigrations, runLegacyStateMigrations } =
      await import("./doctor-state-migrations.js");
    detectLegacyStateMigrations.mockResolvedValueOnce({
      targetAgentId: "main",
      targetMainKey: "main",
      stateDir: "/tmp/state",
      oauthDir: "/tmp/oauth",
      sessions: {
        legacyDir: "/tmp/state/sessions",
        legacyStorePath: "/tmp/state/sessions/sessions.json",
        targetDir: "/tmp/state/agents/main/sessions",
        targetStorePath: "/tmp/state/agents/main/sessions/sessions.json",
        hasLegacy: true,
      },
      agentDir: {
        legacyDir: "/tmp/state/agent",
        targetDir: "/tmp/state/agents/main/agent",
        hasLegacy: false,
      },
      whatsappAuth: {
        legacyDir: "/tmp/oauth",
        targetDir: "/tmp/oauth/whatsapp/default",
        hasLegacy: false,
      },
      preview: ["- Legacy sessions detected"],
    });
    runLegacyStateMigrations.mockResolvedValueOnce({
      changes: ["migrated"],
      warnings: [],
    });

    runLegacyStateMigrations.mockClear();
    confirm.mockClear();

    await doctorCommand(runtime, { yes: true });

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("skips gateway restarts in non-interactive mode", async () => {
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

    const { healthCommand } = await import("./health.js");
    healthCommand.mockRejectedValueOnce(new Error("gateway closed"));

    serviceIsLoaded.mockResolvedValueOnce(true);
    serviceRestart.mockClear();
    confirm.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await doctorCommand(runtime, { nonInteractive: true });

    expect(serviceRestart).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("migrates anthropic oauth config profile id when only email profile exists", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/clawdbot.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
      issues: [],
      legacyIssues: [],
    });

    ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "anthropic:me@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          email: "me@example.com",
        },
      },
    });

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(
      { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      { yes: true },
    );

    const written = writeConfigFile.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    const profiles = (written.auth as { profiles: Record<string, unknown> })
      .profiles;
    expect(profiles["anthropic:me@example.com"]).toBeTruthy();
    expect(profiles["anthropic:default"]).toBeUndefined();
  });

  it("warns when the state directory is missing", async () => {
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

    const missingDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clawdbot-missing-state-"),
    );
    fs.rmSync(missingDir, { recursive: true, force: true });
    process.env.CLAWDBOT_STATE_DIR = missingDir;
    note.mockClear();

    const { doctorCommand } = await import("./doctor.js");
    await doctorCommand(
      { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      { nonInteractive: true, workspaceSuggestions: false },
    );

    const stateNote = note.mock.calls.find(
      (call) => call[1] === "State integrity",
    );
    expect(stateNote).toBeTruthy();
    expect(String(stateNote?.[0])).toContain("CRITICAL");
  });
});
