import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDependency: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  getRuntimeConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
  spawn: vi.fn(),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.getRuntimeConfig,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
    validateConfigObjectWithPlugins: mocks.validateConfigObjectWithPlugins,
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureDependency: mocks.ensureDependency,
  ensureGcloudAuth: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: mocks.ensureTailscaleEndpoint,
  ensureTopic: vi.fn(),
  resolveProjectIdFromGogCredentials: vi.fn(),
  runGcloud: vi.fn(),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: vi.fn((name: string) => name),
}));

const { runGmailService, runGmailSetup } = await import("./gmail-ops.js");

function createGmailConfig(account = "me@example.com", renewEveryMinutes?: number) {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account,
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
        tailscale: { mode: "off" as const },
        renewEveryMinutes,
      },
    },
  };
}

describe("runGmailService", () => {
  beforeEach(() => {
    mocks.ensureDependency.mockResolvedValue(undefined);
    mocks.ensureTailscaleEndpoint.mockResolvedValue(undefined);
    mocks.getRuntimeConfig.mockReturnValue(createGmailConfig());
    mocks.runCommandWithTimeout.mockReset();
    mocks.defaultRuntime.log.mockReset();
    mocks.defaultRuntime.error.mockReset();
    mocks.spawn.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs rejected renewal commands", async () => {
    vi.useFakeTimers();
    mocks.runCommandWithTimeout
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockRejectedValue(new Error("renewal failed"));

    const child = new EventEmitter();
    const kill = vi.fn(() => {
      child.emit("exit", null, "SIGTERM");
      return true;
    });
    mocks.spawn.mockReturnValue(Object.assign(child, { kill, killed: false }));

    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    let shutdown: (() => void) | undefined;
    try {
      await runGmailService({});
      shutdown = process
        .rawListeners("SIGINT")
        .find((listener) => !existingSigintListeners.has(listener)) as (() => void) | undefined;

      await vi.advanceTimersByTimeAsync(720 * 60_000);

      expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
        "gmail watch renew failed: Error: renewal failed",
      );
    } finally {
      shutdown?.();
    }
  });

  it("keeps a stalled foreground renewal single-flight", async () => {
    vi.useFakeTimers();
    let resolveRenewal!: (value: { code: number; stdout: string; stderr: string }) => void;
    const renewal = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      resolveRenewal = resolve;
    });
    mocks.getRuntimeConfig.mockReturnValue(createGmailConfig("me@example.com", 1));
    mocks.runCommandWithTimeout
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockImplementation(async () => await renewal);

    const child = new EventEmitter();
    const kill = vi.fn(() => {
      child.emit("exit", null, "SIGTERM");
      return true;
    });
    mocks.spawn.mockReturnValue(Object.assign(child, { kill, killed: false }));

    const existingSigintListeners = new Set(process.rawListeners("SIGINT"));
    let shutdown: (() => void) | undefined;
    try {
      await runGmailService({});
      shutdown = process
        .rawListeners("SIGINT")
        .find((listener) => !existingSigintListeners.has(listener)) as (() => void) | undefined;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      const callsWhileStalled = mocks.runCommandWithTimeout.mock.calls.length;
      resolveRenewal({ code: 0, stdout: "", stderr: "" });
      await Promise.resolve();

      expect(callsWhileStalled).toBe(2);
    } finally {
      shutdown?.();
    }
  });
});

describe("runGmailSetup config validation", () => {
  beforeEach(() => {
    mocks.ensureDependency.mockResolvedValue(undefined);
    mocks.runCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    mocks.replaceConfigFile.mockResolvedValue({ path: "/tmp/openclaw.json" });
    mocks.validateConfigObjectWithPlugins.mockImplementation((config: unknown) => ({
      ok: true,
      config,
      warnings: [],
    }));
  });

  // Codex review P2 on #128904: setup builds its next config on the MATERIALIZED snapshot, so
  // channel schema ownership needs the authored counterpart passed explicitly. Without it the
  // fallback reads validation-seeded `plugins.entries.<id>.config` records as operator selection,
  // sets aside `preferOver`, and can reject a replacement-only channel field that validated fine
  // before the command ran — after it has already created GCP resources.
  it("hands validation the authored snapshot as its source half", async () => {
    const authored = { hooks: { enabled: true, token: "hook-token" } };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      // Runtime-shaped: carries a seeded entry the operator never wrote.
      config: {
        hooks: { enabled: true, token: "hook-token" },
        plugins: { entries: { "voxchat-classic": { config: {} } } },
      },
      sourceConfig: authored,
      path: "/tmp/openclaw.json",
    });

    await runGmailSetup({
      account: "me@example.com",
      project: "demo",
      pushEndpoint: "https://example.test/hook",
      tailscale: "off",
    } as never);

    const call = mocks.validateConfigObjectWithPlugins.mock.calls[0];
    expect(call?.[1]).toEqual({ sourceConfig: authored });
  });
});
