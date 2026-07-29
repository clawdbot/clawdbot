import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { reefPeerIdentity } from "./friend-types.js";
import { isReefPairingApprovalToken, openReefTrustStore } from "./trust-store.js";
import type { RelayFriend } from "./types.js";

let stateDir: string;

function config(handle = "molty", relayUrl = "https://reefwire.ai") {
  return ReefChannelConfigSchema.parse({ handle, relayUrl });
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

function peerTrust() {
  const identity = generateIdentity();
  return {
    autonomy: "bounded" as const,
    ed25519PublicKey: identity.signing.publicKey,
    x25519PublicKey: identity.encryption.publicKey,
    keyEpoch: 1,
    safetyNumberChanged: false,
    approvedAt: 1_752_537_600_000,
  };
}

function relayFriend(peer = "clawd", keyEpoch = 1): RelayFriend {
  const identity = generateIdentity();
  return {
    peer,
    status: "active",
    initiated_by: "molty",
    vouching_mutual: null,
    ed25519_pub: identity.signing.publicKey,
    x25519_pub: identity.encryption.publicKey,
    key_epoch: keyEpoch,
  };
}

describe("ReefTrustStore", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-trust-"));
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("retains delivery bindings across envelope and receipt relay windows", () => {
    const opened: OpenKeyedStoreOptions[] = [];
    const mockRuntime = createPluginRuntimeMock();
    mockRuntime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) => {
      opened.push(options);
      return createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    };

    openReefTrustStore(mockRuntime, config());

    expect(
      opened.find((options) => options.namespace === "outbound-deliveries")?.defaultTtlMs,
    ).toBe(61 * 24 * 60 * 60 * 1_000);
  });

  it("persists peer pins and autonomy in shared plugin-state SQLite", () => {
    const first = openReefTrustStore(runtime(), config());
    first.set("clawd", peerTrust());
    first.setAutonomy("clawd", "extended");

    const reopened = openReefTrustStore(runtime(), config());
    expect(reopened.get("@clawd")).toMatchObject({
      autonomy: "extended",
      keyEpoch: 1,
      safetyNumberChanged: false,
    });
    expect(reopened.list().map((entry) => entry.peer)).toEqual(["clawd"]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
  });

  it("isolates trust by relay identity instead of machine-specific key paths", () => {
    const molty = openReefTrustStore(runtime(), config("molty"));
    molty.set("clawd", peerTrust());

    expect(openReefTrustStore(runtime(), config("molty")).get("clawd")).toBeDefined();
    expect(openReefTrustStore(runtime(), config("other")).get("clawd")).toBeUndefined();
    expect(
      openReefTrustStore(runtime(), config("molty", "https://relay.example")).get("clawd"),
    ).toBeUndefined();
  });

  it("persists and consumes concurrent outbound request intents separately from active trust", () => {
    const store = openReefTrustStore(runtime(), config());

    const first = store.recordOutboundRequest("clawd", 123);
    const second = store.recordOutboundRequest("clawd", 456);
    expect(first).not.toBe(second);
    expect(openReefTrustStore(runtime(), config()).hasOutboundRequest("clawd")).toBe(true);
    expect(store.get("clawd")).toBeUndefined();
    expect(store.removeOutboundRequest("clawd", first)).toBe(true);
    expect(store.outboundRequestStatus("clawd", first)).toBe("superseded");
    expect(store.outboundRequestStatus("clawd", second)).toBe("current");
    expect(store.removeOutboundRequest("clawd", second)).toBe(true);
    expect(store.hasOutboundRequest("clawd")).toBe(false);
    expect(store.outboundRequestStatus("clawd", second)).toBe("revoked");
  });

  it("persists and atomically consumes outbound delivery bindings", () => {
    const id = "01JZ0000000000000000000120";
    const bodyHash = "a".repeat(64);
    const recipient = reefPeerIdentity(peerTrust());
    const binding = { bodyHash, textHash: "b".repeat(64), recipient };
    openReefTrustStore(runtime(), config()).recordOutboundDelivery("clawd", id, binding);

    const reopened = openReefTrustStore(runtime(), config());
    expect(reopened.outboundDelivery("clawd", id)).toMatchObject(binding);
    expect(
      reopened.consumeOutboundDelivery("clawd", id, { ...binding, bodyHash: "b".repeat(64) }),
    ).toBe(false);
    expect(
      reopened.consumeOutboundDelivery("clawd", id, { ...binding, textHash: "c".repeat(64) }),
    ).toBe(false);
    expect(reopened.outboundDelivery("clawd", id)).toMatchObject(binding);
    expect(reopened.consumeOutboundDelivery("clawd", id, binding)).toBe(true);
    expect(reopened.outboundDelivery("clawd", id)).toBeUndefined();
    expect(reopened.consumeOutboundDelivery("clawd", id, binding)).toBe(false);
  });

  it("keeps rejection notices durable until the sender agent consumes them", () => {
    const id = "01JZ0000000000000000000121";
    const bodyHash = "a".repeat(64);
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const textHash = "c".repeat(64);
    const binding = { bodyHash, textHash, recipient };
    store.set("clawd", trustedPeer);
    store.recordOutboundDelivery("clawd", id, binding);

    expect(
      store.recordOutboundRejection(
        "clawd",
        id,
        { ...binding, bodyHash: "b".repeat(64) },
        "guard_deny",
      ),
    ).toBe(false);
    expect(store.recordOutboundRejection("clawd", id, binding, "guard_deny")).toBe(true);

    const reopened = openReefTrustStore(runtime(), config());
    expect(reopened.pendingOutboundRejections()).toEqual([
      { id, peer: "clawd", recipient, textHash, category: "guard_deny" },
    ]);
    expect(reopened.consumeOutboundDelivery("clawd", id, binding)).toBe(false);
    const noticeState = { lastRejectionAt: 10_000, lastResendAt: 10_100 };
    expect(reopened.reserveOutboundRejectionNotice("clawd", id, recipient, noticeState)).toEqual({
      kind: "reserved",
    });
    expect(reopened.pendingOutboundRejections()).toEqual([
      {
        id,
        peer: "clawd",
        recipient,
        textHash,
        category: "guard_deny",
        reservedNotice: noticeState,
      },
    ]);
    expect(reopened.completeOutboundRejection("clawd", id, noticeState)).toBe(true);
    expect(reopened.pendingOutboundRejections()).toEqual([]);
    expect(reopened.outboundDelivery("clawd", id)).toBeUndefined();
    expect(reopened.rejectionNoticeState("clawd")).toEqual(noticeState);
    expect(reopened.completeOutboundRejection("clawd", id, noticeState)).toBe(true);
  });

  it("marks imported delivery rejections stop-only in the atomic receipt update", () => {
    const id = "01JZ0000000000000000000129";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash: "a".repeat(64), recipient };
    store.set("clawd", trustedPeer);
    store.recordOutboundDelivery("clawd", id, binding, { resendDisabled: true });

    expect(store.recordOutboundRejection("clawd", id, binding, "guard_deny")).toBe(true);
    expect(store.pendingOutboundRejections()).toEqual([
      {
        id,
        peer: "clawd",
        recipient,
        category: "guard_deny",
        reservedNotice: { lastRejectionAt: expect.any(Number) },
      },
    ]);
  });

  it("does not recover a rejected delivery after the peer identity changes", () => {
    const id = "01JZ0000000000000000000124";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    const binding = { bodyHash: "a".repeat(64), recipient };
    store.set("clawd", trustedPeer);
    store.recordOutboundDelivery("clawd", id, binding);
    store.recordOutboundRejection("clawd", id, binding, "guard_deny");

    store.set("clawd", peerTrust());

    expect(store.pendingOutboundRejections()).toEqual([]);
    expect(() =>
      store.reserveOutboundRejectionNotice("clawd", id, recipient, {
        lastRejectionAt: 10_000,
      }),
    ).toThrow("changed keys before rejection recovery");
  });

  it("persists restart-stable rejection notice cooldowns monotonically", () => {
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    const recipient = reefPeerIdentity(trustedPeer);
    store.set("clawd", trustedPeer);
    const latestId = "01JZ0000000000000000000122";
    const latestBinding = { bodyHash: "a".repeat(64), recipient };
    store.recordOutboundDelivery("clawd", latestId, latestBinding);
    store.recordOutboundRejection("clawd", latestId, latestBinding, "guard_deny");
    const latestState = {
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    };
    store.reserveOutboundRejectionNotice("clawd", latestId, recipient, latestState);
    store.completeOutboundRejection("clawd", latestId, latestState);

    const reopened = openReefTrustStore(runtime(), config());
    expect(reopened.rejectionNoticeState("clawd")).toEqual({
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    });

    const olderId = "01JZ0000000000000000000123";
    const olderBinding = { bodyHash: "b".repeat(64), recipient };
    reopened.recordOutboundDelivery("clawd", olderId, olderBinding);
    reopened.recordOutboundRejection("clawd", olderId, olderBinding, "guard_deny");
    const olderState = {
      lastRejectionAt: 9_000,
      lastResendAt: 9_100,
    };
    reopened.reserveOutboundRejectionNotice("clawd", olderId, recipient, olderState);
    reopened.completeOutboundRejection("clawd", olderId, olderState);
    expect(reopened.rejectionNoticeState("clawd")).toEqual({
      lastRejectionAt: 10_000,
      lastResendAt: 10_100,
    });
  });

  it("rejects autonomy updates for untrusted or invalid peers", () => {
    const store = openReefTrustStore(runtime(), config());

    expect(() => store.setAutonomy("clawd", "notify-only")).toThrow("not locally trusted");
    expect(() => store.get("not a handle")).toThrow("Invalid Reef peer handle");
  });

  it("updates autonomy atomically without overwriting concurrent safety state", () => {
    const store = openReefTrustStore(runtime(), config());
    store.set("clawd", peerTrust());
    const beforeSafetyChange = store.snapshot("clawd");

    store.setAutonomy("clawd", "extended");
    expect(store.markSafetyNumberChanged("clawd", beforeSafetyChange.revision)).toBe(true);

    expect(store.get("clawd")).toMatchObject({
      autonomy: "extended",
      safetyNumberChanged: true,
    });
  });

  it("preserves a concurrent autonomy update when repinning peer keys", () => {
    const store = openReefTrustStore(runtime(), config());
    store.set("clawd", peerTrust());
    const beforeRepin = store.snapshot("clawd");
    const friend = relayFriend();

    store.setAutonomy("clawd", "notify-only");
    expect(store.commitPeerTrust(friend, { expectedRevision: beforeRepin.revision }, 123)).toBe(
      true,
    );

    expect(store.get("clawd")).toMatchObject({
      autonomy: "notify-only",
      ed25519PublicKey: friend.ed25519_pub,
      approvedAt: 123,
    });
  });

  it("rejects a stale trust commit after local revocation", () => {
    const store = openReefTrustStore(runtime(), config());
    const requestId = store.recordOutboundRequest("clawd", 123);
    const beforeRemoval = store.snapshot("clawd");

    store.remove("clawd");

    expect(
      store.commitPeerTrust(relayFriend(), {
        expectedRevision: beforeRemoval.revision,
        expectedOutboundRequestId: requestId,
      }),
    ).toBe(false);
    expect(store.get("clawd")).toBeUndefined();
    expect(store.hasOutboundRequest("clawd")).toBe(false);
  });

  it("binds pairing approvals to the relay identity and exact peer keys", () => {
    const identity = generateIdentity();
    const friend: RelayFriend = {
      peer: "clawd",
      status: "pending",
      initiated_by: "clawd",
      vouching_mutual: null,
      ed25519_pub: identity.signing.publicKey,
      x25519_pub: identity.encryption.publicKey,
      key_epoch: 2,
    };
    const molty = openReefTrustStore(runtime(), config("molty"));
    const token = molty.createPairingApproval(friend);

    expect(isReefPairingApprovalToken(token)).toBe(true);
    expect(molty.parsePairingApproval(token)).toEqual({
      peer: "clawd",
      keyEpoch: 2,
      trustRevision: 0,
    });
    expect(molty.matchesPairingApproval(token, friend)).toBe(true);
    expect(openReefTrustStore(runtime(), config("other")).parsePairingApproval(token)).toBe(
      undefined,
    );
    expect(molty.matchesPairingApproval(token, { ...friend, ed25519_pub: "C".repeat(43) })).toBe(
      false,
    );

    molty.remove("clawd");
    expect(molty.matchesPairingApproval(token, friend)).toBe(false);
  });
});

describe("ReefTrustStore overdue outbound deliveries", () => {
  const OVERDUE_MS = 10 * 60 * 1_000;

  it("reports an unacknowledged delivery overdue exactly once", () => {
    const id = "01JZ0000000000000000000140";
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    store.set("clawd", trustedPeer);
    const binding = {
      bodyHash: "a".repeat(64),
      textHash: "b".repeat(64),
      recipient: reefPeerIdentity(trustedPeer),
    };
    store.recordOutboundDelivery("clawd", id, binding);

    expect(store.overdueOutboundDeliveries(OVERDUE_MS)).toEqual([]);
    const later = Date.now() + OVERDUE_MS + 1_000;
    expect(store.overdueOutboundDeliveries(OVERDUE_MS, later)).toMatchObject([
      { peer: "clawd", id },
    ]);

    expect(store.markOutboundDeliveryOverdueNotified("clawd", id)).toBe(true);
    expect(store.markOutboundDeliveryOverdueNotified("clawd", id)).toBe(false);
    expect(store.overdueOutboundDeliveries(OVERDUE_MS, later)).toEqual([]);
  });

  it("excludes rejected and unpinned deliveries from the overdue sweep", () => {
    const store = openReefTrustStore(runtime(), config());
    const trustedPeer = peerTrust();
    store.set("clawd", trustedPeer);
    const later = Date.now() + OVERDUE_MS + 1_000;

    const rejectedId = "01JZ0000000000000000000141";
    const rejectedBinding = {
      bodyHash: "c".repeat(64),
      recipient: reefPeerIdentity(trustedPeer),
    };
    store.recordOutboundDelivery("clawd", rejectedId, rejectedBinding);
    expect(store.recordOutboundRejection("clawd", rejectedId, rejectedBinding, "guard_deny")).toBe(
      true,
    );

    const unpinnedId = "01JZ0000000000000000000142";
    store.recordOutboundDelivery("stranger", unpinnedId, {
      bodyHash: "d".repeat(64),
      recipient: reefPeerIdentity(peerTrust()),
    });

    expect(store.overdueOutboundDeliveries(OVERDUE_MS, later)).toEqual([]);
    expect(store.markOutboundDeliveryOverdueNotified("clawd", rejectedId)).toBe(false);
  });
});
