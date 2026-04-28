import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendMemoryHostEvent,
  readMemoryHostEvents,
  resolveMemoryHostEventLogPath,
} from "./memory-host-events.js";
import { createClaimableDedupe, createPersistentDedupe } from "./persistent-dedupe.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDir } = createPluginSdkTestHarness();

function createDedupe(root: string, overrides?: { ttlMs?: number }) {
  return createPersistentDedupe({
    ttlMs: overrides?.ttlMs ?? 24 * 60 * 60 * 1000,
    memoryMaxSize: 100,
    fileMaxEntries: 1000,
    resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
  });
}

describe("memory host event journal helpers", () => {
  it("appends and reads typed workspace events", async () => {
    const workspaceDir = await createTempDir("memory-host-events-");

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "glacier backup",
      resultCount: 1,
      results: [
        {
          path: "memory/2026-04-05.md",
          startLine: 1,
          endLine: 3,
          score: 0.9,
        },
      ],
    });
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.dream.completed",
      timestamp: "2026-04-05T13:00:00.000Z",
      phase: "light",
      lineCount: 4,
      storageMode: "both",
      inlinePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
      reportPath: path.join(workspaceDir, "memory", "dreaming", "light", "2026-04-05.md"),
    });

    const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
    await expect(fs.readFile(eventLogPath, "utf8")).resolves.toContain(
      '"type":"memory.recall.recorded"',
    );

    const events = await readMemoryHostEvents({ workspaceDir });
    const tail = await readMemoryHostEvents({ workspaceDir, limit: 1 });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("memory.recall.recorded");
    expect(events[1]?.type).toBe("memory.dream.completed");
    expect(tail).toHaveLength(1);
    expect(tail[0]?.type).toBe("memory.dream.completed");
  });
});

describe("createPersistentDedupe", () => {
  it("deduplicates keys, persists across instances, warms up, and checks recent keys", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const first = createDedupe(root);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createDedupe(root);
    expect(await second.hasRecent("m1", { namespace: "a" })).toBe(true);
    expect(await second.warmup("a")).toBe(1);
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m2", { namespace: "a" })).toBe(true);

    const raceDedupe = createDedupe(root, { ttlMs: 10_000 });
    const [raceFirst, raceSecond] = await Promise.all([
      raceDedupe.checkAndRecord("race-key", { namespace: "feishu" }),
      raceDedupe.checkAndRecord("race-key", { namespace: "feishu" }),
    ]);
    expect(raceFirst).toBe(true);
    expect(raceSecond).toBe(false);
  });

  it("falls back to memory-only behavior on disk errors", async () => {
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => path.join("/dev/null", "dedupe.json"),
    });

    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(true);
    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(false);
  });

  it("warms empty namespaces and skips expired disk entries", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const emptyReader = createDedupe(root, { ttlMs: 10_000 });
    expect(await emptyReader.warmup("nonexistent")).toBe(0);

    const oldNow = Date.now() - 2000;
    await fs.writeFile(
      path.join(root, "acct.json"),
      JSON.stringify({ "old-msg": oldNow, "new-msg": Date.now() }),
    );

    const reader = createDedupe(root, { ttlMs: 1000 });
    expect(await reader.warmup("acct")).toBe(1);
    expect(await reader.checkAndRecord("old-msg", { namespace: "acct" })).toBe(true);
    expect(await reader.checkAndRecord("new-msg", { namespace: "acct" })).toBe(false);
  });
});

describe("createClaimableDedupe", () => {
  it("mirrors in-flight duplicates, serializes races, and records on commit", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-1")).resolves.toEqual({ kind: "claimed" });
    const duplicate = await dedupe.claim("line:evt-1");
    expect(duplicate.kind).toBe("inflight");

    const commit = dedupe.commit("line:evt-1");
    await expect(commit).resolves.toBe(true);
    if (duplicate.kind === "inflight") {
      await expect(duplicate.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:evt-1")).resolves.toEqual({ kind: "duplicate" });

    const claims = await Promise.all([dedupe.claim("line:race-1"), dedupe.claim("line:race-1")]);
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "inflight")).toHaveLength(1);

    const waitingClaim = claims.find((claim) => claim.kind === "inflight");
    await expect(dedupe.commit("line:race-1")).resolves.toBe(true);
    if (waitingClaim?.kind === "inflight") {
      await expect(waitingClaim.pending).resolves.toBe(true);
    }
    await expect(dedupe.claim("line:race-1")).resolves.toEqual({ kind: "duplicate" });
  });

  it("rejects waiting duplicates when the active claim releases with an error", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

    await expect(dedupe.claim("line:evt-2")).resolves.toEqual({ kind: "claimed" });
    const duplicate = await dedupe.claim("line:evt-2");
    expect(duplicate.kind).toBe("inflight");

    const failure = new Error("transient failure");
    dedupe.release("line:evt-2", { error: failure });
    if (duplicate.kind === "inflight") {
      await expect(duplicate.pending).rejects.toThrow("transient failure");
    }
    await expect(dedupe.claim("line:evt-2")).resolves.toEqual({ kind: "claimed" });
  });

  it("supports persistent-backed recent checks and warmup", async () => {
    const root = await createTempDir("openclaw-claimable-dedupe-");
    const writer = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
    });

    await expect(writer.claim("m1", { namespace: "acct" })).resolves.toEqual({ kind: "claimed" });
    await expect(writer.commit("m1", { namespace: "acct" })).resolves.toBe(true);

    const reader = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
    });

    expect(await reader.hasRecent("m1", { namespace: "acct" })).toBe(true);
    expect(await reader.warmup("acct")).toBe(1);
    await expect(reader.claim("m1", { namespace: "acct" })).resolves.toEqual({
      kind: "duplicate",
    });
  });
});
