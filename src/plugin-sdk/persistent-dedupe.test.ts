import path from "node:path";
import { describe, expect, it } from "vitest";
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

describe("createPersistentDedupe", () => {
  it("deduplicates keys and persists across instances", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const first = createDedupe(root);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createDedupe(root);
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m1", { namespace: "b" })).toBe(true);
  });

  it("guards concurrent calls for the same key", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const dedupe = createDedupe(root, { ttlMs: 10_000 });

    const [first, second] = await Promise.all([
      dedupe.checkAndRecord("race-key", { namespace: "feishu" }),
      dedupe.checkAndRecord("race-key", { namespace: "feishu" }),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(false);
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

  it("warmup loads persisted entries into memory", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const writer = createDedupe(root);
    expect(await writer.checkAndRecord("msg-1", { namespace: "acct" })).toBe(true);
    expect(await writer.checkAndRecord("msg-2", { namespace: "acct" })).toBe(true);

    const reader = createDedupe(root);
    const loaded = await reader.warmup("acct");
    expect(loaded).toBe(2);
    expect(await reader.checkAndRecord("msg-1", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("msg-2", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("msg-3", { namespace: "acct" })).toBe(true);
  });

  it("checks for recent keys without mutating the store", async () => {
    const root = await createTempDir("openclaw-dedupe-");
    const writer = createDedupe(root);
    expect(await writer.checkAndRecord("peek-me", { namespace: "acct" })).toBe(true);

    const reader = createDedupe(root);
    expect(await reader.hasRecent("peek-me", { namespace: "acct" })).toBe(true);
    expect(await reader.hasRecent("missing", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("peek-me", { namespace: "acct" })).toBe(false);
  });

  it.each([
    {
      name: "returns 0 when no disk file exists",
      setup: async (root: string) => createDedupe(root, { ttlMs: 10_000 }),
      namespace: "nonexistent",
      expectedLoaded: 0,
      verify: async () => undefined,
    },
    {
      name: "skips expired entries",
      setup: async (root: string) => {
        const writer = createDedupe(root, { ttlMs: 1000 });
        const oldNow = Date.now() - 2000;
        expect(await writer.checkAndRecord("old-msg", { namespace: "acct", now: oldNow })).toBe(
          true,
        );
        expect(await writer.checkAndRecord("new-msg", { namespace: "acct" })).toBe(true);
        return createDedupe(root, { ttlMs: 1000 });
      },
      namespace: "acct",
      expectedLoaded: 1,
      verify: async (reader: ReturnType<typeof createDedupe>) => {
        expect(await reader.checkAndRecord("old-msg", { namespace: "acct" })).toBe(true);
        expect(await reader.checkAndRecord("new-msg", { namespace: "acct" })).toBe(false);
      },
    },
  ])("warmup $name", async ({ setup, namespace, expectedLoaded, verify }) => {
    const root = await createTempDir("openclaw-dedupe-");
    const reader = await setup(root);
    const loaded = await reader.warmup(namespace);
    expect(loaded).toBe(expectedLoaded);
    await verify(reader);
  });
});

describe("createClaimableDedupe", () => {
  it("mirrors concurrent in-flight duplicates and records on commit", async () => {
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
  });

  it("serializes concurrent first-claim races onto one in-flight owner", async () => {
    const dedupe = createClaimableDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
    });

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
