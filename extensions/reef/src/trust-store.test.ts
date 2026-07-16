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
