import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64url,
  generateIdentity,
  signReceipt,
  verifyChain,
  verifyChainSegment,
  type ReviewRequest,
} from "../protocol/index.js";
import {
  assertReefIdentityBinding,
  clearReefSetupSession,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  loadReefSetupSession,
  openStores,
  finalizeReefIdentityBinding,
  REEF_DELIVERED_NAMESPACE,
  ReefInboxCursorStore,
  REEF_REPLAY_TTL_MS,
  REEF_REVIEWS_NAMESPACE,
  releaseReefIdentityReservation,
  reserveReefIdentityBinding,
  ReviewApprovalStore,
  reefReplayStoreKey,
  saveReefSetupSession,
} from "./state.js";

const auditKey = base64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const replayKey = base64url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const receiptId = "01JZ0000000000000000000000";

function createRuntime(stateDir: string) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return runtime;
}

function bindIdentity(runtime: ReturnType<typeof createRuntime>, handle: string): void {
  finalizeReefIdentityBinding(
    runtime,
    reserveReefIdentityBinding(runtime, { handle, relayUrl: "https://reefwire.ai" }),
  );
}

describe("Reef SQLite state", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-state-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists a monotonic inbox cursor for the bound Reef identity", () => {
    const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
    const store = new ReefInboxCursorStore(createRuntime(stateDir), binding);

    expect(store.load()).toBe(0);
    store.advance(12);
    store.advance(7);

    expect(new ReefInboxCursorStore(createRuntime(stateDir), binding).load()).toBe(12);
    expect(() =>
      new ReefInboxCursorStore(createRuntime(stateDir), {
        handle: "clawd",
        relayUrl: "https://reefwire.ai",
      }).load(),
    ).toThrow("different identity");
  });

  it("does not let an expired audit writer replace a committed successor link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    await openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "initial",
      { id: 1 },
      10,
    );
    const competing = openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit;
    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    let triggerCompetingWriter = true;
    let competingAppend: Promise<unknown> | undefined;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      if (options.namespace !== "audit") {
        return store;
      }
      return {
        ...store,
        registerIfAbsent(key, value, opts) {
          const inserted = store.registerIfAbsent(key, value, opts);
          if (triggerCompetingWriter && inserted) {
            triggerCompetingWriter = false;
            vi.advanceTimersByTime(31_000);
            competingAppend = competing.appendEvent("winner", { id: 2 }, 12);
          }
          return inserted;
        },
      };
    };

    const expired = openStores(runtime, keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "expired",
      { id: 3 },
      11,
    );
    await expect(expired).rejects.toThrow();
    await expect(competingAppend).resolves.toBeDefined();
    const retained = await competing.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["initial", "winner"]);
  });

  it("retains expired audit cleanup state when takeover cleanup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    await openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "initial",
      { id: 1 },
      10,
    );

    const takeoverRuntime = createRuntime(stateDir);
    const takeoverOpenStore = takeoverRuntime.state.openSyncKeyedStore;
    let failCleanup = true;
    takeoverRuntime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = takeoverOpenStore<T>(options);
      if (options.namespace !== "audit") {
        return store;
      }
      return {
        ...store,
        delete(key) {
          const deleted = store.delete(key);
          if (failCleanup) {
            failCleanup = false;
            throw new Error("simulated cleanup interruption");
          }
          return deleted;
        },
      };
    };
    const takeover = openStores(takeoverRuntime, keys, { auditMaxEntries: 2 }).audit;
    const stalledRuntime = createRuntime(stateDir);
    const stalledOpenStore = stalledRuntime.state.openSyncKeyedStore;
    let takeoverAppend: Promise<unknown> | undefined;
    stalledRuntime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = stalledOpenStore<T>(options);
      if (options.namespace !== "audit") {
        return store;
      }
      return {
        ...store,
        registerIfAbsent(key, value, opts) {
          const inserted = store.registerIfAbsent(key, value, opts);
          if (inserted && !takeoverAppend) {
            vi.advanceTimersByTime(31_000);
            takeoverAppend = takeover.appendEvent("interrupted-takeover", { id: 2 }, 12);
          }
          return inserted;
        },
      };
    };

    await expect(
      openStores(stalledRuntime, keys, { auditMaxEntries: 2 }).audit.appendEvent(
        "stalled",
        { id: 3 },
        11,
      ),
    ).rejects.toThrow();
    await expect(takeoverAppend).rejects.toThrow("simulated cleanup interruption");
    await expect(
      openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
        "recovered",
        { id: 4 },
        13,
      ),
    ).resolves.toBeDefined();
    const retained = await openStores(createRuntime(stateDir), keys, {
      auditMaxEntries: 2,
    }).audit.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["initial", "recovered"]);
  });

  it("persists keys and registration state without creating Reef files", async () => {
    const runtime = createRuntime(stateDir);
    const keys = await generateAndStoreKeys(runtime);
    bindIdentity(runtime, "molty");
    saveReefSetupSession(runtime, {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });

    expect(await loadKeys(createRuntime(stateDir))).toEqual(keys);
    expect(loadReefIdentityBinding(createRuntime(stateDir))).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    expect(loadReefSetupSession(createRuntime(stateDir))?.session).toBe("setup-secret");
    clearReefSetupSession(runtime);
    expect(loadReefSetupSession(runtime)).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "data", "reef"))).toBe(false);
  });

  it("atomically rejects redirecting stored identity keys to another handle", () => {
    const runtime = createRuntime(stateDir);
    bindIdentity(runtime, "molty");

    expect(() =>
      reserveReefIdentityBinding(runtime, {
        handle: "other",
        relayUrl: "https://reefwire.ai",
      }),
    ).toThrow("already holds the Reef identity @molty");
    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    expect(() =>
      assertReefIdentityBinding(runtime, {
        handle: "other",
        relayUrl: "https://reefwire.ai",
      }),
    ).toThrow("already holds the Reef identity @molty");
  });

  it("conditionally releases or finalizes an identity reservation", () => {
    const runtime = createRuntime(stateDir);
    const released = reserveReefIdentityBinding(runtime, {
      handle: "first",
      relayUrl: "https://reefwire.ai",
    });
    releaseReefIdentityReservation(runtime, released);
    expect(loadReefIdentityBinding(runtime)).toBeUndefined();

    const finalized = reserveReefIdentityBinding(runtime, {
      handle: "second",
      relayUrl: "https://reefwire.ai",
    });
    finalizeReefIdentityBinding(runtime, finalized);
    releaseReefIdentityReservation(runtime, finalized);
    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "second",
      relayUrl: "https://reefwire.ai",
    });
  });

  it("does not transfer a live reservation to a concurrent retry", () => {
    const runtime = createRuntime(stateDir);
    const reservation = reserveReefIdentityBinding(runtime, {
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });

    expect(() =>
      reserveReefIdentityBinding(runtime, {
        handle: "molty",
        relayUrl: "https://reefwire.ai",
      }),
    ).toThrow("already holds the Reef identity @molty");
    finalizeReefIdentityBinding(runtime, reservation);
    expect(loadReefIdentityBinding(runtime)?.handle).toBe("molty");
  });

  it("allows only the same binding to take over an expired reservation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00.000Z"));
    const runtime = createRuntime(stateDir);
    reserveReefIdentityBinding(runtime, {
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    vi.advanceTimersByTime(10 * 60_000 + 1);

    expect(() =>
      reserveReefIdentityBinding(runtime, {
        handle: "other",
        relayUrl: "https://reefwire.ai",
      }),
    ).toThrow("already holds the Reef identity @molty");
    const retry = reserveReefIdentityBinding(runtime, {
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    finalizeReefIdentityBinding(runtime, retry);
    expect(loadReefIdentityBinding(runtime)?.handle).toBe("molty");
  });

  it("appends and reopens a verified audit chain", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const first = openStores(createRuntime(stateDir), keys);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        first.audit.appendEvent("test", { id: index }, 10 + index),
      ),
    );

    const reopened = await openStores(createRuntime(stateDir), keys).audit.entries();
    expect(reopened).toHaveLength(20);
    expect(verifyChain(reopened)).toBe(true);
  });

  it("retains a verifiable audit suffix after bounded eviction", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const store = openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit;
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    await store.appendEvent("three", { id: 3 }, 12);

    const retained = await store.entries();
    expect(retained.map((entry) => entry.event.seq)).toEqual([2, 3]);
    expect(
      verifyChainSegment(retained, {
        previousHash: retained[0]!.prevHash,
        previousSeq: 1,
        head: retained[1]!.entryHash,
      }),
    ).toBe(true);
  });

  it("does not evict committed audit history when head advancement fails", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const initial = openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit;
    await initial.appendEvent("one", { id: 1 }, 10);
    await initial.appendEvent("two", { id: 2 }, 11);

    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    let failAdvance = true;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      if (options.namespace !== "audit-head" || !store.update) {
        return store;
      }
      const update = store.update;
      return {
        ...store,
        update(key, updateValue, opts) {
          return update(
            key,
            (current) => {
              const next = updateValue(current);
              const head = next as { seq?: number; pending?: unknown } | undefined;
              if (failAdvance && head?.seq === 3 && head.pending === undefined) {
                failAdvance = false;
                throw new Error("simulated head write failure");
              }
              return next;
            },
            opts,
          );
        },
      };
    };

    const failing = openStores(runtime, keys, { auditMaxEntries: 2 }).audit;
    await expect(failing.appendEvent("three", { id: 3 }, 12)).rejects.toThrow();
    const unchanged = await openStores(createRuntime(stateDir), keys, {
      auditMaxEntries: 2,
    }).audit.entries();
    expect(unchanged.map((entry) => entry.event.type)).toEqual(["one", "two"]);

    await openStores(createRuntime(stateDir), keys, { auditMaxEntries: 2 }).audit.appendEvent(
      "three",
      { id: 3 },
      12,
    );
    const recovered = await openStores(createRuntime(stateDir), keys, {
      auditMaxEntries: 2,
    }).audit.entries();
    expect(recovered.map((entry) => entry.event.type)).toEqual(["two", "three"]);
  });

  it("roundtrips encrypted replay completions and durable dedupe state", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const stores = openStores(createRuntime(stateDir), keys);
    const receipt = signReceipt(
      {
        id: receiptId,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      identity.signing.secretKey,
    );
    const body = { text: "RECOVERABLE SECRET BODY" };

    await expect(stores.replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    await stores.replay.complete("alice", receiptId, receipt, body);
    const reopened = openStores(createRuntime(stateDir), keys).replay;
    await expect(reopened.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("duplicate");
    await expect(reopened.completed("alice", receiptId)).resolves.toEqual({ receipt, body });
    await expect(reopened.claim("alice", receiptId, "d".repeat(64))).resolves.toBe("mismatch");

    const raw = createPluginStateSyncKeyedStoreForTests<unknown>("reef", {
      namespace: "replay",
      maxEntries: 3_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(JSON.stringify(raw.entries())).not.toContain(body.text);
  });

  it("does not steal a live replay claim owned by another process", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const runtime = createRuntime(stateDir);
    const raw = createPluginStateSyncKeyedStoreForTests<{
      peer: string;
      id: string;
      envelopeHash: string;
      state: "in_flight";
      claimOwner: string;
      claimExpiresAt: number;
    }>("reef", {
      namespace: "replay",
      maxEntries: 3_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const key = reefReplayStoreKey("alice", receiptId);
    raw.register(key, {
      peer: "alice",
      id: receiptId,
      envelopeHash: "c".repeat(64),
      state: "in_flight",
      claimOwner: "other-process",
      claimExpiresAt: Date.now() + 5 * 60_000,
    });

    const replay = openStores(runtime, keys).replay;
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("in_flight");
    expect(raw.lookup(key)?.claimOwner).toBe("other-process");

    raw.register(key, {
      ...raw.lookup(key)!,
      claimExpiresAt: Date.now() - 1,
    });
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    const firstOwner = raw.lookup(key)?.claimOwner;
    expect(firstOwner).not.toBe("other-process");
    const firstExpiry = raw.lookup(key)?.claimExpiresAt ?? 0;
    await replay.refresh?.("alice", receiptId);
    expect(raw.lookup(key)?.claimExpiresAt).toBeGreaterThanOrEqual(firstExpiry);

    raw.register(key, {
      ...raw.lookup(key)!,
      claimExpiresAt: Date.now() - 1,
    });
    await expect(replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    expect(raw.lookup(key)?.claimOwner).not.toBe(firstOwner);
  });

  it("persists review decisions and delivered ids", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const stores = openStores(createRuntime(stateDir), keys);
    const review: ReviewRequest = {
      id: receiptId,
      from: "alice#1",
      to: "bob#1",
      direction: "outbound",
      bodyHash: "a".repeat(64),
      approvalDigest: "b".repeat(64),
      verdict: {
        decision: "review",
        category: "ambiguous",
        reason: "Owner review.",
        model: "test-model",
        policyVersion: "v1",
      },
    };

    await expect(stores.reviews.request(review)).resolves.toBeUndefined();
    await expect(stores.reviews.decide(review.approvalDigest, true)).resolves.toBe(true);
    await expect(
      openStores(createRuntime(stateDir), keys).reviews.request(review),
    ).resolves.toEqual({
      approved: true,
      approvalDigest: review.approvalDigest,
    });
    await stores.delivered.add(receiptId);
    await expect(openStores(createRuntime(stateDir), keys).delivered.has(receiptId)).resolves.toBe(
      true,
    );
  });

  it("fails closed instead of evicting live replay and delivered state", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const stores = openStores(createRuntime(stateDir), keys, {
      replayMaxEntries: 1,
      deliveredMaxEntries: 1,
    });

    await expect(stores.replay.claim("alice", "first", "a".repeat(64))).resolves.toBe("new");
    await stores.replay.consume("alice", "first");
    await expect(stores.replay.claim("alice", "second", "b".repeat(64))).rejects.toThrow();
    await expect(stores.replay.claim("alice", "first", "a".repeat(64))).resolves.toBe("duplicate");

    await stores.delivered.add("first");
    await expect(stores.delivered.add("second")).rejects.toThrow();
    await expect(stores.delivered.has("first")).resolves.toBe(true);
  });

  it("fails when a pending review claim does not persist", async () => {
    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      return options.namespace === REEF_REVIEWS_NAMESPACE
        ? { ...store, registerIfAbsent: () => false }
        : store;
    };
    const review: ReviewRequest = {
      id: receiptId,
      from: "alice#1",
      to: "bob#1",
      direction: "outbound",
      bodyHash: "a".repeat(64),
      approvalDigest: "b".repeat(64),
      verdict: {
        decision: "review",
        category: "ambiguous",
        reason: "Owner review.",
        model: "test-model",
        policyVersion: "v1",
      },
    };

    await expect(new ReviewApprovalStore(runtime).request(review)).rejects.toThrow(
      "Failed persisting Reef pending review",
    );
  });

  it("fails when a delivered marker claim does not persist", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const runtime = createRuntime(stateDir);
    const openSyncKeyedStore = runtime.state.openSyncKeyedStore;
    runtime.state.openSyncKeyedStore = <T>(
      options: OpenKeyedStoreOptions,
    ): PluginStateSyncKeyedStore<T> => {
      const store = openSyncKeyedStore<T>(options);
      return options.namespace === REEF_DELIVERED_NAMESPACE
        ? { ...store, registerIfAbsent: () => false }
        : store;
    };

    await expect(openStores(runtime, keys).delivered.add(receiptId)).rejects.toThrow(
      "Failed persisting Reef delivered marker",
    );
  });

  it("evicts completed review decisions before rejecting new pending work", async () => {
    const runtime = createRuntime(stateDir);
    const store = new ReviewApprovalStore(runtime, 2);
    const review = (id: string, digest: string): ReviewRequest => ({
      id,
      from: "alice#1",
      to: "bob#1",
      direction: "outbound",
      bodyHash: "a".repeat(64),
      approvalDigest: digest,
      verdict: {
        decision: "review",
        category: "ambiguous",
        reason: "Owner review.",
        model: "test-model",
        policyVersion: "v1",
      },
    });
    const first = review("first", "1".repeat(64));
    const second = review("second", "2".repeat(64));
    const third = review("third", "3".repeat(64));

    await store.request(first);
    await store.decide(first.approvalDigest, false);
    await store.request(second);
    await store.request(third);

    await expect(store.list()).resolves.toEqual([second, third]);
  });
});
