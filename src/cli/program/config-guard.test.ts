// Config guard tests cover program-level config checks before command execution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import { ExitError } from "../../runtime.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { formatCliCommand } from "../command-format.js";
import { ensureConfigReady, testApi } from "./config-guard.js";

const pluginPackagingRecoveryHint = [
  "This is a plugin packaging issue, not a local config problem.",
  "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
].join("\n");

const loadAndMaybeMigrateDoctorConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const setRuntimeConfigSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/doctor-config-preflight.js", () => ({
  runDoctorConfigPreflight: loadAndMaybeMigrateDoctorConfigMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  setRuntimeConfigSnapshot: setRuntimeConfigSnapshotMock,
}));

type ConfigIssue = { path: string; message: string };

function makeSnapshot() {
  return {
    exists: false,
    valid: true,
    issues: [] as ConfigIssue[],
    warnings: [] as ConfigIssue[],
    legacyIssues: [] as ConfigIssue[],
    path: "/tmp/openclaw.json",
  };
}

function makeRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function plainErrorCalls(runtime: ReturnType<typeof makeRuntime>): string[] {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  return runtime.error.mock.calls.map((call) => String(call[0]).replace(ansiPattern, ""));
}

async function withCapturedStdout(run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(String(chunk));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
    return writes.join("");
  } finally {
    writeSpy.mockRestore();
  }
}

describe("ensureConfigReady", () => {
  const resetConfigGuardStateForTests = testApi.resetConfigGuardStateForTests;
  const tempRoots: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  async function runEnsureConfigReady(commandPath: string[], suppressDoctorStdout = false) {
    const runtime = makeRuntime();
    await ensureConfigReady({ runtime: runtime as never, commandPath, suppressDoctorStdout });
    return runtime;
  }

  function setInvalidSnapshot(overrides?: Partial<ReturnType<typeof makeSnapshot>>) {
    const snapshot = {
      ...makeSnapshot(),
      exists: true,
      valid: false,
      issues: [{ path: "channels.quietchat", message: "invalid" }],
      ...overrides,
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
      snapshot,
      baseConfig: {},
    });
  }

  function useTempOpenClawHome(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-"));
    tempRoots.push(root);
    setTestEnvValue("OPENCLAW_HOME", root);
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    return root;
  }

  function writeLegacyTaskSidecarMarker(root: string): void {
    const markerPath = path.join(root, ".openclaw", "tasks", "runs.sqlite");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  }

  function writePendingTaskSidecarArchiveMarker(root: string): void {
    const markerPath = path.join(root, ".openclaw", "tasks", "runs.sqlite");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(`${markerPath}.migrated`, "");
    fs.writeFileSync(`${markerPath}-wal`, "");
  }

  function writeStateMarker(root: string, relativePath: string): void {
    const markerPath = path.join(root, ".openclaw", relativePath);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{}");
  }

  beforeEach(() => {
    envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    vi.clearAllMocks();
    resetConfigGuardStateForTests();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    useTempOpenClawHome();
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => ({
      snapshot: makeSnapshot(),
      baseConfig: {},
    }));
  });

  afterEach(() => {
    envSnapshot?.restore();
    envSnapshot = undefined;
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "skips doctor flow for status task reads without legacy state",
      commandPath: ["status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for update status",
      commandPath: ["update", "status"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for agent without legacy state",
      commandPath: ["agent"],
      expectedDoctorCalls: 0,
    },
    {
      name: "skips doctor flow for plugin listing without legacy state",
      commandPath: ["plugins", "list"],
      expectedDoctorCalls: 0,
    },
    {
      name: "runs doctor flow for commands that may mutate state without legacy state",
      commandPath: ["message"],
      expectedDoctorCalls: 1,
    },
  ])("$name", async ({ commandPath, expectedDoctorCalls }) => {
    await runEnsureConfigReady(commandPath);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(expectedDoctorCalls);
    if (expectedDoctorCalls > 0) {
      expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
        migrateState: true,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        crossStateDirImports: false,
      });
    }
  });

  it("keeps status config guard reads non-observing", async () => {
    await runEnsureConfigReady(["status"]);

    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ observe: false });
  });

  it("runs doctor flow when lightweight startup detection finds legacy state", async () => {
    const root = useTempOpenClawHome();
    writeLegacyTaskSidecarMarker(root);

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      observe: false,
      crossStateDirImports: false,
    });
  });

  it("runs doctor flow when lightweight startup detection finds a pending SQLite archive", async () => {
    const root = useTempOpenClawHome();
    writePendingTaskSidecarArchiveMarker(root);

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      observe: false,
      crossStateDirImports: false,
    });
  });

  it("requires a startup migration checkpoint for foreground gateway startup", async () => {
    await runEnsureConfigReady(["gateway"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      crossStateDirImports: false,
      requireStartupMigrationCheckpoint: true,
    });
  });

  it("honors a deferred migration exit after preflight resources unwind", async () => {
    let preflightUnwound = false;
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      try {
        throw new ExitError(78);
      } finally {
        preflightUnwound = true;
      }
    });
    const runtime = makeRuntime();
    runtime.exit.mockImplementation(() => {
      expect(preflightUnwound).toBe(true);
    });

    await expect(
      ensureConfigReady({ runtime: runtime as never, commandPath: ["gateway"] }),
    ).rejects.toMatchObject({ name: "ExitError", code: 78 });

    expect(runtime.exit).toHaveBeenCalledWith(78);
  });

  it("does not require a startup migration checkpoint for gateway probes", async () => {
    await runEnsureConfigReady(["gateway", "health"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      crossStateDirImports: false,
    });
  });

  it("runs doctor flow for legacy sessions without task sidecars", async () => {
    const root = useTempOpenClawHome();
    fs.mkdirSync(path.join(root, ".openclaw", "sessions"), { recursive: true });

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it("runs doctor flow before agent commands when the legacy plugin install index exists", async () => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, "plugins/installs.json");

    await runEnsureConfigReady(["agent"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      crossStateDirImports: false,
    });
  });

  it("preserves plugin listing migrations when the legacy plugin install index exists", async () => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, "plugins/installs.json");
    const migratedSnapshot = {
      ...makeSnapshot(),
      config: { plugins: { entries: { legacy: { enabled: true } } } },
      runtimeConfig: { plugins: { entries: { legacy: { enabled: true } } } },
      sourceConfig: { plugins: { entries: { legacy: { enabled: true } } } },
    };
    loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
      snapshot: migratedSnapshot,
      baseConfig: {},
    });

    await runEnsureConfigReady(["plugins", "list"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
      migrateState: true,
      migrateLegacyConfig: false,
      invalidConfigNote: false,
      crossStateDirImports: false,
    });
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      migratedSnapshot.runtimeConfig,
      migratedSnapshot.sourceConfig,
    );
  });

  it("preserves plugin listing migrations when the shared state database exists", async () => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, "state/openclaw.sqlite");

    await runEnsureConfigReady(["plugins", "list"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it.each([
    { commandPath: ["agent"], source: "exec-approvals.json" },
    { commandPath: ["status"], source: "plugin-binding-approvals.json" },
    { commandPath: ["plugins", "list"], source: "exec-approvals.json" },
    { commandPath: ["tasks", "list"], source: "plugin-binding-approvals.json" },
  ])(
    "runs notice-only preflight for $commandPath with default-state $source",
    async ({ commandPath, source }) => {
      const root = useTempOpenClawHome();
      const stateDir = path.join(root, "custom-state");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      writeStateMarker(root, source);
      const sourcePath = path.join(root, ".openclaw", source);
      const sourceRaw = fs.readFileSync(sourcePath, "utf8");

      await runEnsureConfigReady(commandPath);

      expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
      expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith({
        migrateState: true,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        ...(commandPath[0] === "status" ? { observe: false } : {}),
        crossStateDirImports: false,
      });
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceRaw);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
    },
  );

  it.each([
    ["Discord model picker preferences", "discord/model-picker-preferences.json"],
    ["Discord thread bindings", "discord/thread-bindings.json"],
    ["Feishu dedupe sidecar", "feishu/dedup/default.json"],
    ["Telegram bot info cache", "telegram/bot-info-default.json"],
    ["Telegram update offset", "telegram/update-offset-default.json"],
    ["Telegram sticker cache", "telegram/sticker-cache.json"],
    ["Telegram thread bindings", "telegram/thread-bindings-default.json"],
    ["Telegram pairing allowFrom", "credentials/telegram-allowFrom.json"],
    ["iMessage reply short-id cache", "imessage/reply-cache.jsonl"],
    ["iMessage sent echo cache", "imessage/sent-echoes.jsonl"],
    ["iMessage catchup cursor", "imessage/catchup/default__37a8eec1ce19.json"],
    ["WhatsApp root auth", "credentials/creds.json"],
  ])("runs doctor flow for bundled channel legacy state: %s", async (_label, relativePath) => {
    const root = useTempOpenClawHome();
    writeStateMarker(root, relativePath);

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it("uses shared tilde expansion for OPENCLAW_HOME in the startup detector", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-home-"));
    tempRoots.push(root);
    setTestEnvValue("HOME", root);
    setTestEnvValue("OPENCLAW_HOME", "~/svc");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    writeLegacyTaskSidecarMarker(path.join(root, "svc"));

    await runEnsureConfigReady(["status"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "status", commandPath: ["status"] },
    { name: "plugin listing", commandPath: ["plugins", "list"] },
  ])(
    "runs doctor flow for $name with configured custom session stores",
    async ({ commandPath }) => {
      const root = useTempOpenClawHome();
      const customStore = path.join(root, "sessions", "sessions.json");
      const snapshot = {
        ...makeSnapshot(),
        config: { session: { store: customStore } },
        runtimeConfig: { session: { store: customStore } },
      };
      readConfigFileSnapshotMock.mockResolvedValue(snapshot);
      loadAndMaybeMigrateDoctorConfigMock.mockResolvedValue({
        snapshot,
        baseConfig: {},
      });

      await runEnsureConfigReady(commandPath);

      expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledOnce();
    },
  );

  it("pins a valid preflight snapshot for command code reuse", async () => {
    const snapshot = {
      ...makeSnapshot(),
      config: { runtime: true },
      runtimeConfig: { runtime: true, materialized: true },
      sourceConfig: { source: true },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);

    await runEnsureConfigReady(["health"]);

    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      snapshot.runtimeConfig,
      snapshot.sourceConfig,
    );
  });

  it("pins plugin listing config without loading state migration runtime", async () => {
    const snapshot = {
      ...makeSnapshot(),
      config: { plugins: { entries: { alpha: { enabled: true } } } },
      runtimeConfig: { plugins: { entries: { alpha: { enabled: true } } } },
      sourceConfig: { plugins: { entries: { alpha: { enabled: true } } } },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);

    await runEnsureConfigReady(["plugins", "list"]);

    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      snapshot.runtimeConfig,
      snapshot.sourceConfig,
    );
  });

  it("retries the cached config snapshot after a read rejection", async () => {
    const originalVitest = process.env.VITEST;
    process.env.VITEST = "false";
    const transientError = new Error("temporary config read failure");
    const recoveredSnapshot = makeSnapshot();
    readConfigFileSnapshotMock
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(recoveredSnapshot);

    try {
      await expect(runEnsureConfigReady(["health"])).rejects.toThrow(transientError);
      await expect(runEnsureConfigReady(["health"])).resolves.toBeDefined();
      await expect(runEnsureConfigReady(["health"])).resolves.toBeDefined();
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(undefined, undefined);
  });

  it("exits for invalid config on non-allowlisted commands", async () => {
    setInvalidSnapshot();
    const runtime = await runEnsureConfigReady(["message"]);

    expect(plainErrorCalls(runtime)).toEqual([
      "OpenClaw config is invalid",
      "File: /tmp/openclaw.json",
      "Problem:",
      "  - channels.quietchat: invalid",
      "",
      `Fix: ${formatCliCommand("openclaw doctor --fix")}`,
      `Inspect: ${formatCliCommand("openclaw config validate")}`,
      "Audit, status, health, logs, tasks list/audit, and doctor commands still run with invalid config.",
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("replaces doctor fix advice for plugin packaging-only invalid config", async () => {
    setInvalidSnapshot({
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
    });
    const runtime = await runEnsureConfigReady(["message"]);
    const calls = plainErrorCalls(runtime);

    expect(calls).toContain(`Fix: ${pluginPackagingRecoveryHint}`);
    expect(calls).not.toContain(`Fix: ${formatCliCommand("openclaw doctor --fix")}`);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("does not exit for invalid config on allowlisted commands", async () => {
    setInvalidSnapshot({
      issues: [{ path: "agents.defaults", message: 'Unrecognized key: "agentRuntime"' }],
    });
    const statusRuntime = await runEnsureConfigReady(["status"]);
    expect(statusRuntime.exit).not.toHaveBeenCalled();

    const auditRuntime = await runEnsureConfigReady(["audit"]);
    expect(auditRuntime.exit).not.toHaveBeenCalled();

    const bareGatewayRuntime = await runEnsureConfigReady(["gateway"]);
    expect(bareGatewayRuntime.exit).not.toHaveBeenCalled();

    const gatewayRunRuntime = await runEnsureConfigReady(["gateway", "run"]);
    expect(gatewayRunRuntime.exit).not.toHaveBeenCalled();

    const gatewayRuntime = await runEnsureConfigReady(["gateway", "health"]);
    expect(gatewayRuntime.exit).not.toHaveBeenCalled();

    const tasksListRuntime = await runEnsureConfigReady(["tasks", "list"]);
    expect(tasksListRuntime.exit).not.toHaveBeenCalled();

    const tasksParentRuntime = await runEnsureConfigReady(["tasks"]);
    expect(tasksParentRuntime.exit).not.toHaveBeenCalled();

    const tasksAuditRuntime = await runEnsureConfigReady(["tasks", "audit"]);
    expect(tasksAuditRuntime.exit).not.toHaveBeenCalled();

    const tasksRunRuntime = await runEnsureConfigReady(["tasks", "run"]);
    expect(tasksRunRuntime.exit).toHaveBeenCalledWith(1);

    const doctorRuntime = await runEnsureConfigReady(["doctor", "fix"]);
    expect(doctorRuntime.exit).not.toHaveBeenCalled();
    expect(doctorRuntime.error).toHaveBeenCalledWith(expect.stringContaining("agentRuntime"));
  });

  it("allows an explicit invalid-config override", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    await ensureConfigReady({
      runtime: runtime as never,
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("runs doctor migration flow only once per module instance", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    const runtimeA = makeRuntime();
    const runtimeB = makeRuntime();

    await ensureConfigReady({ runtime: runtimeA as never, commandPath: ["message"] });
    await ensureConfigReady({ runtime: runtimeB as never, commandPath: ["message"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("still runs doctor flow when stdout suppression is enabled", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    await runEnsureConfigReady(["message"], true);
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("prevents preflight note noise when suppression is enabled", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      note("Doctor warnings", "Config warnings");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], true);
    });
    expect(output).not.toContain("Doctor warnings");
  });

  it("allows preflight note noise when suppression is not enabled", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      note("Doctor warnings", "Config warnings");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], false);
    });
    expect(output).toContain("Doctor warnings");
  });

  it("does not suppress unrelated concurrent stdout writes while suppressing preflight notes", async () => {
    writeLegacyTaskSidecarMarker(useTempOpenClawHome());
    let releasePreflight: (() => void) | undefined;
    let preflightStarted: (() => void) | undefined;
    const preflightStartedPromise = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    const releasePreflightPromise = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    loadAndMaybeMigrateDoctorConfigMock.mockImplementation(async () => {
      note("Doctor warnings", "Config warnings");
      preflightStarted?.();
      await releasePreflightPromise;
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });

    let callbackCalled = false;
    const output = await withCapturedStdout(async () => {
      const ready = runEnsureConfigReady(["message"], true);
      await preflightStartedPromise;
      process.stdout.write("Concurrent output\n", () => {
        callbackCalled = true;
      });
      releasePreflight?.();
      await ready;
    });

    expect(output).toContain("Concurrent output");
    expect(output).not.toContain("Doctor warnings");
    expect(callbackCalled).toBe(true);
  });
});
