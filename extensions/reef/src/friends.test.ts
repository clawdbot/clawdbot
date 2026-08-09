import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefFriendManager } from "./friends.js";
import type { ReefTransportClient } from "./transport.js";
import { ReefRelayError } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";
import type { RelayFriend } from "./types.js";

let stateDir: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function relayFriend(
  peer: string,
  status: RelayFriend["status"],
  identity = generateIdentity(),
  keyEpoch = 1,
  initiatedBy = peer,
): RelayFriend {
  return {
    peer,
    status,
    initiated_by: initiatedBy,
    vouching_mutual: null,
    key_epoch: keyEpoch,
    ed25519_pub: identity.signing.publicKey,
    x25519_pub: identity.encryption.publicKey,
  };
}

function runtime() {
  const mockRuntime = createPluginRuntimeMock();
  mockRuntime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return mockRuntime;
}

function config() {
  return ReefChannelConfigSchema.parse({ handle: "me" });
}

function trust() {
  return openReefTrustStore(runtime(), config());
}

function approvals(...initial: string[]): ConstructorParameters<typeof ReefFriendManager>[2] & {
  values: Set<string>;
  remove: ReturnType<typeof vi.fn>;
} {
  const values = new Set(initial);
  return {
    values,
    list: vi.fn(async () => [...values]),
    remove: vi.fn(async (peer: string) => values.delete(peer)),
  };
}

function addApproval(
  store: ReturnType<typeof trust>,
  pairing: ReturnType<typeof approvals>,
  friend: RelayFriend,
): string {
  const token = store.createPairingApproval(friend);
  pairing.values.add(token);
  return token;
}

function transport(friend: RelayFriend) {
  return {
    handle: "me",
    listFriends: vi.fn(async () => ({ friendships: [friend] })),
    requestFriend: vi.fn(async () => ({ status: "pending" })),
    respondFriend: vi.fn(async (candidate: RelayFriend, accept: boolean) => {
      candidate.status = accept ? "active" : "blocked";
      return { peer: candidate.peer, status: candidate.status };
    }),
    removeFriend: vi.fn(async () => {
      friend.status = "blocked";
    }),
  };
}

describe("ReefFriendManager pairing", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-friends-"));
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("surfaces an inbound request and consumes pairing approval into durable peer trust", async () => {
    const pending = relayFriend("alice", "pending");
    const relay = transport(pending);
    const pairing = approvals();
    const store = trust();
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);
    const issue = vi.fn(async () => {});

    await manager.surfacePairingCandidates(issue);
    expect(issue).toHaveBeenCalledWith({
      peer: "alice",
      fingerprint: expect.stringMatching(/^[0-9a-f ]+$/),
      code: "alice",
      approvalToken: store.createPairingApproval(pending),
    });
    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(store.get("alice")).toBeUndefined();

    addApproval(store, pairing, pending);
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(relay.respondFriend).toHaveBeenCalledWith(pending, true);
    expect(store.get("alice")).toMatchObject({
      autonomy: "bounded",
      ed25519PublicKey: pending.ed25519_pub,
      x25519PublicKey: pending.x25519_pub,
      keyEpoch: 1,
      safetyNumberChanged: false,
    });
    expect(pairing.values).toEqual(new Set());
  });

  it("consumes approval before accepting or pinning an inbound friendship", async () => {
    const pending = relayFriend("alice", "pending");
    const relay = transport(pending);
    const pairing = approvals();
    pairing.remove.mockRejectedValue(new Error("approval store unavailable"));
    const store = trust();
    addApproval(store, pairing, pending);
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.reconcile()).rejects.toThrow("approval store unavailable");
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(store.get("alice")).toBeUndefined();
  });

  it("does not reuse an approval another reconciler already consumed", async () => {
    const pending = relayFriend("alice", "pending");
    const relay = transport(pending);
    const pairing = approvals();
    pairing.remove.mockResolvedValue(false);
    const store = trust();
    addApproval(store, pairing, pending);
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(store.get("alice")).toBeUndefined();
  });

  it("adopts a locally requested friendship once active and consumes its intent marker", async () => {
    const accepted = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const relay = transport(accepted);
    const store = trust();
    const manager = new ReefFriendManager(
      relay as unknown as ReefTransportClient,
      store,
      approvals(),
    );

    await manager.request("alice");
    expect(store.hasOutboundRequest("alice")).toBe(true);
    accepted.status = "active";
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(store.get("alice")).toMatchObject({ autonomy: "bounded", keyEpoch: 1 });
    expect(store.hasOutboundRequest("alice")).toBe(false);

    const reopened = trust();
    expect(reopened.get("alice")).toMatchObject({ autonomy: "bounded" });
    expect(fs.existsSync(path.join(stateDir, "requested.json"))).toBe(false);
  });

  it("removes a relay edge created after another process revoked the request", async () => {
    const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const requestStarted = deferred<void>();
    const relayResult = deferred<{ status: string }>();
    const requestingRelay = transport(pending);
    requestingRelay.requestFriend.mockImplementation(async () => {
      requestStarted.resolve(undefined);
      return await relayResult.promise;
    });
    const requester = new ReefFriendManager(
      requestingRelay as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );
    const remover = new ReefFriendManager(
      transport(pending) as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );

    const request = requester.request("alice");
    await requestStarted.promise;
    await remover.remove("alice");
    relayResult.resolve({ status: "pending" });

    await expect(request).rejects.toThrow("concurrently revoked");
    expect(requestingRelay.removeFriend).toHaveBeenCalledWith("alice");
    expect(trust().hasOutboundRequest("alice")).toBe(false);
  });

  it("refences local intent after a slow relay removal deletes a newer request", async () => {
    const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const removalStarted = deferred<void>();
    const relayRemoval = deferred<void>();
    const removingRelay = transport(pending);
    removingRelay.removeFriend.mockImplementation(async () => {
      removalStarted.resolve(undefined);
      await relayRemoval.promise;
    });
    const remover = new ReefFriendManager(
      removingRelay as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );
    const requester = new ReefFriendManager(
      transport(pending) as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );

    const removal = remover.remove("alice");
    await removalStarted.promise;
    await expect(requester.request("alice")).resolves.toEqual({ status: "pending" });
    expect(trust().hasOutboundRequest("alice")).toBe(true);
    relayRemoval.resolve(undefined);
    await removal;

    expect(trust().hasOutboundRequest("alice")).toBe(false);
    expect(trust().get("alice")).toBeUndefined();
  });

  it("does not let one rejected attempt erase another process's request intent", async () => {
    const pending = relayFriend("alice", "pending", generateIdentity(), 1, "me");
    const requestStarted = deferred<void>();
    const relayResult = deferred<{ status: string }>();
    const rejectedRelay = transport(pending);
    rejectedRelay.requestFriend.mockImplementation(async () => {
      requestStarted.resolve(undefined);
      return await relayResult.promise;
    });
    const first = new ReefFriendManager(
      rejectedRelay as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );
    const second = new ReefFriendManager(
      transport(pending) as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );

    const rejected = first.request("alice");
    const rejection = expect(rejected).rejects.toThrow("invalid request");
    await requestStarted.promise;
    await expect(second.request("alice")).resolves.toEqual({ status: "pending" });
    relayResult.reject(new ReefRelayError(400, "invalid request"));
    await rejection;

    const reopened = trust();
    expect(reopened.hasOutboundRequest("alice")).toBe(true);
    expect(Object.keys(reopened.snapshot("alice").outboundRequests ?? {})).toHaveLength(1);
  });

  it("fails closed and requests approval for an active relay edge with no local intent", async () => {
    const accepted = relayFriend("alice", "active", generateIdentity(), 1, "me");
    const relay = transport(accepted);
    const manager = new ReefFriendManager(
      relay as unknown as ReefTransportClient,
      trust(),
      approvals(),
    );
    const issue = vi.fn(async () => {});

    await expect(manager.reconcile()).resolves.toEqual([]);
    await manager.surfacePairingCandidates(issue);

    expect(issue).toHaveBeenCalledOnce();
    expect(manager.trust.get("alice")).toBeUndefined();
  });

  it("surfaces a reapproval edge with no local pin and does not duplicate an existing approval", async () => {
    const changed = relayFriend("alice", "reapprove_required");
    const pairing = approvals();
    const manager = new ReefFriendManager(
      transport(changed) as unknown as ReefTransportClient,
      trust(),
      pairing,
    );
    const issue = vi.fn(async () => {});

    await manager.surfacePairingCandidates(issue);
    expect(issue).toHaveBeenCalledOnce();

    addApproval(manager.trust, pairing, changed);
    issue.mockClear();
    await manager.surfacePairingCandidates(issue);
    expect(issue).not.toHaveBeenCalled();
  });

  it("accepts reapprove_required with unchanged keys after a fresh bound approval", async () => {
    const reapproval = relayFriend("alice", "reapprove_required");
    const relay = transport(reapproval);
    const pairing = approvals();
    const store = trust();
    store.set("alice", {
      autonomy: "extended",
      ed25519PublicKey: reapproval.ed25519_pub,
      x25519PublicKey: reapproval.x25519_pub,
      keyEpoch: reapproval.key_epoch,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);
    const issue = vi.fn(async () => {});

    await manager.surfacePairingCandidates(issue);
    expect(issue).toHaveBeenCalledOnce();
    addApproval(store, pairing, reapproval);
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);

    expect(relay.respondFriend).toHaveBeenCalledWith(reapproval, true);
    expect(store.get("alice")).toMatchObject({
      autonomy: "extended",
      safetyNumberChanged: false,
    });
    expect(pairing.values).toEqual(new Set());
  });

  it("accepts an approved pending edge whose keys are already pinned", async () => {
    const pending = relayFriend("alice", "pending");
    const relay = transport(pending);
    const pairing = approvals();
    const store = trust();
    store.set("alice", {
      autonomy: "extended",
      ed25519PublicKey: pending.ed25519_pub,
      x25519PublicKey: pending.x25519_pub,
      keyEpoch: pending.key_epoch,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    addApproval(store, pairing, pending);
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.reconcile()).resolves.toEqual(["alice"]);

    expect(relay.respondFriend).toHaveBeenCalledWith(pending, true);
    expect(store.get("alice")).toMatchObject({ autonomy: "extended" });
    expect(pairing.values).toEqual(new Set());
  });

  it("does not recreate trust when local removal races an approved relay response", async () => {
    const pending = relayFriend("alice", "pending");
    const pairing = approvals();
    const store = trust();
    addApproval(store, pairing, pending);
    const relay = transport(pending);
    relay.respondFriend.mockImplementation(async (friend: RelayFriend, accept: boolean) => {
      store.remove(friend.peer);
      pending.status = accept ? "active" : "blocked";
      return { peer: friend.peer, status: pending.status };
    });
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.reconcile()).resolves.toEqual([]);

    expect(relay.respondFriend).toHaveBeenCalledWith(pending, true);
    expect(relay.removeFriend).toHaveBeenCalledWith("alice");
    expect(store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("halts on a key change, then repins only after a fresh approval", async () => {
    const oldIdentity = generateIdentity();
    const nextIdentity = generateIdentity();
    const active = relayFriend("alice", "active", nextIdentity, 2);
    const relay = transport(active);
    const pairing = approvals();
    const store = trust();
    store.set("alice", {
      autonomy: "extended",
      ed25519PublicKey: oldIdentity.signing.publicKey,
      x25519PublicKey: oldIdentity.encryption.publicKey,
      keyEpoch: 1,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(store.get("alice")).toMatchObject({
      ed25519PublicKey: oldIdentity.signing.publicKey,
      keyEpoch: 1,
      safetyNumberChanged: true,
    });

    addApproval(store, pairing, active);
    await expect(manager.reconcile()).resolves.toEqual(["alice"]);
    expect(store.get("alice")).toMatchObject({
      autonomy: "extended",
      ed25519PublicKey: nextIdentity.signing.publicKey,
      x25519PublicKey: nextIdentity.encryption.publicKey,
      keyEpoch: 2,
      safetyNumberChanged: false,
    });
    expect(pairing.values).toEqual(new Set());
  });

  it("deletes stale approvals that have no actionable relay friendship", async () => {
    const blocked = relayFriend("alice", "blocked");
    const store = trust();
    const blockedToken = store.createPairingApproval(blocked);
    const pairing = approvals(blockedToken, "missing");
    const manager = new ReefFriendManager(
      transport(blocked) as unknown as ReefTransportClient,
      store,
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(pairing.remove).toHaveBeenCalledWith(blockedToken);
    expect(pairing.remove).toHaveBeenCalledWith("missing");
    expect(pairing.values).toEqual(new Set());
  });

  it("deletes malformed transient approval entries", async () => {
    const active = relayFriend("alice", "active");
    const pairing = approvals("not a handle");
    const manager = new ReefFriendManager(
      transport(active) as unknown as ReefTransportClient,
      trust(),
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(pairing.remove).toHaveBeenCalledWith("not a handle");
    expect(pairing.values).toEqual(new Set());
  });

  it("never treats an unbound generic allow entry as Reef authorization", async () => {
    const active = relayFriend("alice", "active");
    const pairing = approvals("alice");
    const store = trust();
    const manager = new ReefFriendManager(
      transport(active) as unknown as ReefTransportClient,
      store,
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects a bound approval after the relay keys change", async () => {
    const active = relayFriend("alice", "active");
    const pairing = approvals();
    const store = trust();
    addApproval(store, pairing, active);
    const nextIdentity = generateIdentity();
    active.ed25519_pub = nextIdentity.signing.publicKey;
    active.x25519_pub = nextIdentity.encryption.publicKey;
    active.key_epoch += 1;
    const manager = new ReefFriendManager(
      transport(active) as unknown as ReefTransportClient,
      store,
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects a bound approval minted before local revocation", async () => {
    const pending = relayFriend("alice", "pending");
    const pairing = approvals();
    const store = trust();
    addApproval(store, pairing, pending);
    store.remove("alice");
    const manager = new ReefFriendManager(
      transport(pending) as unknown as ReefTransportClient,
      store,
      pairing,
    );

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("rejects an approval when removal lands after validation but before snapshot", async () => {
    const pending = relayFriend("alice", "pending");
    const pairing = approvals();
    const store = trust();
    addApproval(store, pairing, pending);
    const matchesApproval = store.matchesPairingApproval.bind(store);
    vi.spyOn(store, "matchesPairingApproval").mockImplementation((raw, friend) => {
      const matches = matchesApproval(raw, friend);
      if (matches) {
        store.remove(friend.peer);
      }
      return matches;
    });
    const relay = transport(pending);
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.reconcile()).resolves.toEqual([]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(store.get("alice")).toBeUndefined();
    expect(pairing.values).toEqual(new Set());
  });

  it("revokes every local authorization source even when relay removal fails", async () => {
    const active = relayFriend("alice", "active");
    const relay = transport(active);
    const store = trust();
    const pairing = approvals();
    addApproval(store, pairing, active);
    store.set("alice", {
      autonomy: "bounded",
      ed25519PublicKey: active.ed25519_pub,
      x25519PublicKey: active.x25519_pub,
      keyEpoch: 1,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    store.recordOutboundRequest("alice");
    relay.removeFriend.mockImplementation(async () => {
      expect(store.get("alice")).toBeUndefined();
      expect(store.hasOutboundRequest("alice")).toBe(false);
      throw new ReefRelayError(503, "relay unavailable");
    });
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.remove("alice")).rejects.toThrow("relay unavailable");
    expect(store.get("alice")).toBeUndefined();
    expect(store.hasOutboundRequest("alice")).toBe(false);
    expect(pairing.values).toEqual(new Set());
  });

  it("attempts relay removal when transient approval cleanup fails", async () => {
    const active = relayFriend("alice", "active");
    const relay = transport(active);
    const store = trust();
    const pairing = approvals();
    addApproval(store, pairing, active);
    store.set("alice", {
      autonomy: "bounded",
      ed25519PublicKey: active.ed25519_pub,
      x25519PublicKey: active.x25519_pub,
      keyEpoch: active.key_epoch,
      safetyNumberChanged: false,
      approvedAt: 1,
    });
    pairing.remove.mockRejectedValue(new Error("approval store unavailable"));
    const manager = new ReefFriendManager(relay as unknown as ReefTransportClient, store, pairing);

    await expect(manager.remove("alice")).rejects.toThrow("approval store unavailable");

    expect(relay.removeFriend).toHaveBeenCalledWith("alice");
    expect(store.get("alice")).toBeUndefined();
  });
});
