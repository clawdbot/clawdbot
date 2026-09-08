import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { removeStateAndLinkedPaths } from "./cleanup-utils.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("refuses state removal while a peer owns a cached database, then removes after peer retirement", async () => {
  const stateDir = tempDirs.make("openclaw-cleanup-handle-exclusion-");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const moduleUrl = new URL("../state/openclaw-state-db.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
    import { openOpenClawStateDatabase, closeOpenClawStateDatabase } from ${JSON.stringify(moduleUrl)};
    const owner = openOpenClawStateDatabase();
    process.send({ ready: true, path: owner.path });
    process.once("message", () => {
      closeOpenClawStateDatabase();
      process.disconnect();
    });
  `,
    ],
    {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const plan = {
    stateDir,
    configPath,
    oauthDir: path.join(stateDir, "credentials"),
    configInsideState: true,
    oauthInsideState: true,
  };
  try {
    const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
    expect(ready).toMatchObject({ ready: true });
    await expect(removeStateAndLinkedPaths(plan, runtime)).rejects.toThrow(/handle/i);
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    const closed = once(child, "close", { signal: AbortSignal.timeout(10_000) });
    child.send({ close: true });
    await closed;
    await expect(removeStateAndLinkedPaths(plan, runtime)).resolves.toBe(true);
    expect(fs.existsSync(stateDir)).toBe(false);
  } finally {
    await stopChildProcess(child, 5_000);
  }
});

it("drains the local cache and excludes reopening throughout awaited removal", async () => {
  const stateDir = tempDirs.make("openclaw-cleanup-local-handle-");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, "{}\n");
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const database = openOpenClawStateDatabase(options);
  const retainedStatement = database.db.prepare("PRAGMA data_version");
  retainedStatement.get();
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume!: () => void;
  const resumeRemoval = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const realRm = fsPromises.rm;
  const remove = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, settings) => {
    if (String(target) === configPath) {
      reached();
      await resumeRemoval;
    }
    return realRm(target, settings);
  });
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const deleting = removeStateAndLinkedPaths(
    {
      stateDir,
      configPath,
      oauthDir: path.join(stateDir, "credentials"),
      configInsideState: true,
      oauthInsideState: true,
    },
    runtime,
  );
  try {
    await started;
    expect(database.db.isOpen).toBe(false);
    expect(() => retainedStatement.get()).toThrow(/finalized/);
    const before = fs.statSync(database.path, { bigint: true });
    expect(() => openOpenClawStateDatabase(options)).toThrow(/state-handles/);
    expect(fs.statSync(database.path, { bigint: true })).toEqual(before);
  } finally {
    resume();
    await deleting.finally(() => {
      remove.mockRestore();
      closeOpenClawStateDatabaseForTest();
    });
  }
  expect(fs.existsSync(stateDir)).toBe(false);
  const reopened = openOpenClawStateDatabase(options);
  expect(reopened.db.isOpen).toBe(true);
  closeOpenClawStateDatabaseForTest();
});
