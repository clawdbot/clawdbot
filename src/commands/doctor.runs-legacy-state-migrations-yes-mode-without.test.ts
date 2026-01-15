import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalIsTTY: boolean | undefined;
let originalStateDir: string | undefined;
let originalUpdateInProgress: string | undefined;
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
  confirm.mockReset().mockResolvedValue(true);
  select.mockReset().mockResolvedValue("node");
  note.mockClear();

  readConfigFileSnapshot.mockReset();
  writeConfigFile.mockReset().mockResolvedValue(undefined);
  resolveClawdbotPackageRoot.mockReset().mockResolvedValue(null);
  runGatewayUpdate.mockReset().mockResolvedValue({
    status: "skipped",
    mode: "unknown",
    steps: [],
    durationMs: 0,
  });
  legacyReadConfigFileSnapshot.mockReset().mockResolvedValue({
    path: "/tmp/clawdbot.json",
    exists: false,
    raw: null,
    parsed: {},
    valid: true,
    config: {},
    issues: [],
    legacyIssues: [],
  });
  createConfigIO.mockReset().mockImplementation(() => ({
    readConfigFileSnapshot: legacyReadConfigFileSnapshot,
  }));
  runExec.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
  runCommandWithTimeout.mockReset().mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  });
  ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
  migrateLegacyConfig.mockReset().mockImplementation((raw: unknown) => ({
    config: raw as Record<string, unknown>,
    changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
  }));
  findLegacyGatewayServices.mockReset().mockResolvedValue([]);
  uninstallLegacyGatewayServices.mockReset().mockResolvedValue([]);
  findExtraGatewayServices.mockReset().mockResolvedValue([]);
  renderGatewayServiceCleanupHints.mockReset().mockReturnValue(["cleanup"]);
  resolveGatewayProgramArguments.mockReset().mockResolvedValue({
    programArguments: ["node", "cli", "gateway", "--port", "18789"],
  });
  serviceInstall.mockReset().mockResolvedValue(undefined);
  serviceIsLoaded.mockReset().mockResolvedValue(false);
  serviceStop.mockReset().mockResolvedValue(undefined);
  serviceRestart.mockReset().mockResolvedValue(undefined);
  serviceUninstall.mockReset().mockResolvedValue(undefined);
  callGateway.mockReset().mockRejectedValue(new Error("gateway closed"));

  originalIsTTY = process.stdin.isTTY;
  setStdinTty(true);
  originalStateDir = process.env.CLAWDBOT_STATE_DIR;
  originalUpdateInProgress = process.env.CLAWDBOT_UPDATE_IN_PROGRESS;
  process.env.CLAWDBOT_UPDATE_IN_PROGRESS = "1";
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-doctor-state-"));
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
  if (originalUpdateInProgress === undefined) {
    delete process.env.CLAWDBOT_UPDATE_IN_PROGRESS;
  } else {
    process.env.CLAWDBOT_UPDATE_IN_PROGRESS = originalUpdateInProgress;
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
const resolveClawdbotPackageRoot = vi.fn().mockResolvedValue(null);
const runGatewayUpdate = vi.fn().mockResolvedValue({
  status: "skipped",
  mode: "unknown",
  steps: [],
  durationMs: 0,
});
const migrateLegacyConfig = vi.fn((raw: unknown) => ({
  config: raw as Record<string, unknown>,
  changes: ["Moved routing.allowFrom → channels.whatsapp.allowFrom."],
}));

const runExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
const runCommandWithTimeout = vi.fn().mockResolvedValue({
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
});

const ensureAuthProfileStore = vi.fn().mockReturnValue({ version: 1, profiles: {} });

const legacyReadConfigFileSnapshot = vi.fn().mockResolvedValue({
  path: "/tmp/clawdbot.json",
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

vi.mock("../infra/clawdbot-root.js", () => ({
  resolveClawdbotPackageRoot,
}));

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate,
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
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
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
  randomToken: vi.fn(() => "test-gateway-token"),
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

describe("doctor command", () => {
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
  }, 20_000);

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
    await doctorCommand({ log: vi.fn(), error: vi.fn(), exit: vi.fn() }, { yes: true });

    const written = writeConfigFile.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const profiles = (written.auth as { profiles: Record<string, unknown> }).profiles;
    expect(profiles["anthropic:me@example.com"]).toBeTruthy();
    expect(profiles["anthropic:default"]).toBeUndefined();
  }, 20_000);
});
