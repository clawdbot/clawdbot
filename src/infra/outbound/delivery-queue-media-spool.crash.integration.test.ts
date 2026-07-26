// Proves the production crash boundary this change exists for: a process
// commits a durable row, dies before dispatch, and a fresh process still
// delivers the media. Uses a real child process, real SQLite, and no network.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectEntrySpoolPaths,
  pruneOrphanedDeliveryQueueMedia,
} from "./delivery-queue-media-spool.js";
import { ackDelivery, loadPendingDeliveries } from "./delivery-queue-storage.js";

const CHILD_SCRIPT = fileURLToPath(
  new URL("./delivery-queue-media-spool.crash-child.test-support.ts", import.meta.url),
);

type ChildResult = { id: string; pid: number; artifacts: string[] };

let stateDir: string;
let sourceDir: string;
let child: ChildProcess | null = null;

/** Runs the enqueueing child until it reports a committed row, then kills it. */
async function enqueueThenKillChild(source: string): Promise<ChildResult> {
  const spawned = spawn(
    process.execPath,
    ["--import", "tsx", CHILD_SCRIPT, stateDir, sourceDir, source],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    },
  );
  child = spawned;
  const result = await new Promise<ChildResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`child timed out: ${stderr}`)), 60_000);
    spawned.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((entry) => entry.trim().startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as ChildResult);
      }
    });
    spawned.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    spawned.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early (${code}): ${stderr}`));
    });
  });
  // Kill at the boundary: row committed, nothing dispatched.
  const exited = new Promise<void>((resolve) => {
    spawned.once("exit", () => resolve());
  });
  spawned.kill("SIGKILL");
  await exited;
  child = null;
  return result;
}

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-crash-state-")));
  sourceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "spool-crash-src-")));
});

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});

describe("delivery queue media crash boundary", () => {
  it("delivers media enqueued by a process that died before dispatch", async () => {
    const source = path.join(sourceDir, "voice.ogg");
    await fs.writeFile(source, "opus-bytes");

    const { id, pid, artifacts } = await enqueueThenKillChild(source);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0] as string;
    // The producing process is gone; this test process is the fresh one.
    expect(pid).not.toBe(process.pid);

    const pendingBeforeGc = await loadPendingDeliveries(stateDir);
    expect(pendingBeforeGc.map((entry) => entry.id)).toEqual([id]);
    expect(collectEntrySpoolPaths(pendingBeforeGc[0]?.payloads ?? [], stateDir)).toEqual([
      artifact,
    ]);

    // Even beyond the orphan grace, the pending row keeps its exact artifact.
    await pruneOrphanedDeliveryQueueMedia({
      stateDir,
      nowMs: Date.now() + 2 * 24 * 60 * 60_000,
    });
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("opus-bytes");

    // The producer's own media is gone, exactly as a TTS temp would be.
    await fs.rm(source, { force: true });
    await expect(fs.readFile(source, "utf8")).rejects.toThrow();
    // Recovery replays from the queue-owned copy and still gets the same bytes.
    await expect(fs.readFile(artifact, "utf8")).resolves.toBe("opus-bytes");

    // Delivery succeeds: the row leaves the queue and its artifact goes with it.
    await ackDelivery(id, stateDir);
    expect(await loadPendingDeliveries(stateDir)).toEqual([]);
    await expect(fs.readFile(artifact, "utf8")).rejects.toThrow();
  }, 90_000);
});
