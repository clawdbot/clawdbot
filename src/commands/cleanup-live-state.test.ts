// Destructive cleanup must not remove state owned by an independently running Gateway.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime } from "../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const gatewayService = vi.hoisted(() => ({
  notLoadedText: "is not installed",
  isLoaded: vi.fn(async () => false),
  stop: vi.fn(async () => undefined),
  uninstall: vi.fn(async () => undefined),
}));
const configState = vi.hoisted(() => ({ isNixMode: false }));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  get isNixMode() {
    return configState.isNixMode;
  },
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayService,
}));
const { resetCommand } = await import("./reset.js");
const { uninstallCommand } = await import("./uninstall.js");

const liveOwners = new Set<ChildProcess>();
const testStates = new Set<OpenClawTestState>();

async function stopLiveStateOwner(child: ChildProcess): Promise<void> {
  liveOwners.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.send?.("close");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(forceKill);
  }
}

afterEach(async () => {
  const results = await Promise.allSettled([
    ...[...liveOwners].map((child) => stopLiveStateOwner(child)),
    ...[...testStates].map((state) => state.cleanup()),
  ]);
  liveOwners.clear();
  testStates.clear();
  configState.isNixMode = false;
  vi.clearAllMocks();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "live cleanup test teardown failed",
    );
  }
});

async function startLiveStateOwner(state: OpenClawTestState): Promise<ChildProcess> {
  const lockModuleUrl = pathToFileURL(path.resolve("src/infra/gateway-lock.ts")).href;
  const script = `
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const { acquireGatewayLock } = await import(${JSON.stringify(lockModuleUrl)});
    const lock = await acquireGatewayLock({ allowInTests: true, env: process.env, port: 18789 });
    if (!lock) throw new Error("live owner did not acquire the Gateway lock");
    const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE live_owner (value TEXT); INSERT INTO live_owner VALUES ('held');");
    process.send?.("ready");
    process.on("message", async (message) => {
      if (message !== "close") return;
      database.close();
      await lock.release().catch(() => undefined);
      process.exit(0);
    });
    setInterval(() => {}, 1_000);
  `;
  const env = { ...state.env };
  delete env.NODE_ENV;
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, "openclaw", "gateway"],
    { cwd: path.resolve("."), env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  liveOwners.add(child);
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  await Promise.race([
    once(child, "message").then(([message]) => {
      if (message !== "ready") {
        throw new Error(`unexpected live owner message: ${String(message)}`);
      }
    }),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `live state owner exited before ready (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }),
  ]);
  return child;
}

async function readFiles(paths: readonly string[]): Promise<Buffer[]> {
  return await Promise.all(paths.map((filePath) => fs.readFile(filePath)));
}

describe("destructive cleanup with a live unmanaged state owner", () => {
  it.each([
    {
      command: "unmanaged reset --scope full",
      nixMode: false,
      preservesWorkspace: false,
      serviceChecks: 1,
      aggregatesFailure: false,
      run: (runtime: ReturnType<typeof createNonExitingRuntime>) =>
        resetCommand(runtime, { scope: "full", yes: true, nonInteractive: true }),
    },
    {
      command: "Nix reset --scope full",
      nixMode: true,
      preservesWorkspace: false,
      serviceChecks: 0,
      aggregatesFailure: false,
      run: (runtime: ReturnType<typeof createNonExitingRuntime>) =>
        resetCommand(runtime, { scope: "full", yes: true, nonInteractive: true }),
    },
    {
      command: "uninstall --state",
      nixMode: false,
      preservesWorkspace: true,
      serviceChecks: 0,
      aggregatesFailure: true,
      run: (runtime: ReturnType<typeof createNonExitingRuntime>) =>
        uninstallCommand(runtime, { state: true, yes: true, nonInteractive: true }),
    },
  ])(
    "refuses $command until the SQLite owner exits",
    async ({ aggregatesFailure, nixMode, preservesWorkspace, run, serviceChecks }) => {
      const state = await createOpenClawTestState({
        prefix: "openclaw-cleanup-live-state-",
        layout: "split",
        scenario: "minimal",
        applyEnv: true,
      });
      testStates.add(state);
      configState.isNixMode = nixMode;
      const workspacePath = path.join(state.workspaceDir, "project.bin");
      await state.writeConfig({
        agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
      });
      const markerPath = await state.writeText("keep.txt", "preserved");
      await fs.mkdir(path.dirname(workspacePath), { recursive: true });
      await fs.writeFile(workspacePath, Buffer.from([0, 1, 2, 3, 255]));

      const databasePath = state.statePath("state", "openclaw.sqlite");
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const owner = await startLiveStateOwner(state);
      const livePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
      const liveBytes = await readFiles(livePaths);
      const configBytes = await fs.readFile(state.configPath);

      const blockedRuntime = createNonExitingRuntime();
      vi.spyOn(blockedRuntime, "log").mockImplementation(() => {});
      vi.spyOn(blockedRuntime, "error").mockImplementation(() => {});
      if (aggregatesFailure) {
        await expect(run(blockedRuntime)).rejects.toMatchObject({ name: "ExitError", code: 1 });
        expect(blockedRuntime.error).toHaveBeenCalledWith(
          expect.stringMatching(/Gateway|state directory/i),
        );
      } else {
        await expect(run(blockedRuntime)).rejects.toThrow(/Gateway|state directory/i);
      }
      expect(gatewayService.isLoaded).toHaveBeenCalledTimes(serviceChecks);
      expect(owner.exitCode).toBeNull();
      await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("preserved");
      await expect(readFiles(livePaths)).resolves.toEqual(liveBytes);
      await expect(fs.readFile(state.configPath)).resolves.toEqual(configBytes);

      await stopLiveStateOwner(owner);
      const offlineRuntime = createNonExitingRuntime();
      vi.spyOn(offlineRuntime, "log").mockImplementation(() => {});
      vi.spyOn(offlineRuntime, "error").mockImplementation(() => {});
      await expect(run(offlineRuntime)).resolves.toBeUndefined();

      if (preservesWorkspace) {
        await expect(fs.readFile(workspacePath)).resolves.toEqual(Buffer.from([0, 1, 2, 3, 255]));
        await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        for (const filePath of livePaths) {
          await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } else {
        await expect(fs.access(state.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.access(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves state when workspace configuration is invalid", async () => {
    const state = await createOpenClawTestState({
      prefix: "openclaw-cleanup-invalid-config-",
      layout: "split",
      scenario: "minimal",
      applyEnv: true,
    });
    testStates.add(state);
    const workspaceDir = state.statePath("nested-workspace");
    const workspacePath = path.join(workspaceDir, "project.bin");
    const markerPath = await state.writeText("keep.txt", "preserved");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(workspacePath, Buffer.from([9, 8, 7, 6]));
    await fs.writeFile(
      state.configPath,
      `{"agents":{"entries":{"main":{"workspace":${JSON.stringify(workspaceDir)}}}`,
    );
    const configBytes = await fs.readFile(state.configPath);
    const runtime = createNonExitingRuntime();
    vi.spyOn(runtime, "log").mockImplementation(() => {});
    vi.spyOn(runtime, "error").mockImplementation(() => {});

    await expect(
      uninstallCommand(runtime, { state: true, yes: true, nonInteractive: true }),
    ).rejects.toMatchObject({ name: "ExitError", code: 1 });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("workspace configuration could not be resolved"),
    );
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("preserved");
    await expect(fs.readFile(workspacePath)).resolves.toEqual(Buffer.from([9, 8, 7, 6]));
    await expect(fs.readFile(state.configPath)).resolves.toEqual(configBytes);
  });
});
