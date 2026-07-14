import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { ReefChannelConfigSchema } from "./config-schema.js";
import { ReefFriendManager } from "./friends.js";
import type { ReefTransportClient } from "./transport.js";
import type { RelayFriend } from "./types.js";

function relayFriend(
  peer: string,
  status: RelayFriend["status"],
  identity = generateIdentity(),
  keyEpoch = 1,
): RelayFriend {
  return {
    peer,
    status,
    initiated_by: "alice",
    vouching_mutual: null,
    key_epoch: keyEpoch,
    ed25519_pub: identity.signing.publicKey,
    x25519_pub: identity.encryption.publicKey,
  };
}

function transport(friend: RelayFriend) {
  return {
    listFriends: vi.fn(async () => ({ friendships: [friend] })),
    respondFriend: vi.fn(async (peer: string, accept: boolean) => ({
      peer,
      status: accept ? "active" : "blocked",
    })),
  };
}

describe("ReefFriendManager pairing", () => {
  it("surfaces a pending request but pins keys and accepts only after owner approval", async () => {
    const pending = relayFriend("alice", "pending");
    const relay = transport(pending);
    const cfg = ReefChannelConfigSchema.parse({});
    const manager = new ReefFriendManager(cfg, relay as unknown as ReefTransportClient);
    const issue = vi.fn(async () => {});

    await manager.surfacePending(issue);
    expect(issue).toHaveBeenCalledWith({
      peer: "alice",
      fingerprint: expect.stringMatching(/^[0-9a-f ]+$/),
      code: "alice",
    });
    expect(cfg.friends).toEqual({});
    expect(relay.respondFriend).not.toHaveBeenCalled();

    await expect(manager.reconcileApproved([])).resolves.toEqual([]);
    expect(cfg.friends).toEqual({});
    expect(relay.respondFriend).not.toHaveBeenCalled();

    await expect(manager.reconcileApproved(["alice"])).resolves.toEqual(["alice"]);
    expect(relay.respondFriend).toHaveBeenCalledWith("alice", true);
    expect(cfg.friends.alice).toMatchObject({
      ed25519PublicKey: pending.ed25519_pub,
      x25519PublicKey: pending.x25519_pub,
      keyEpoch: 1,
      safetyNumberChanged: false,
    });
  });

  it("adopts a friendship this claw requested once the peer accepts, without local pairing approval", async () => {
    const accepted = relayFriend("alice", "active");
    const relay = {
      ...transport(accepted),
      requestFriend: vi.fn(async () => ({ status: "pending" })),
    };
    const cfg = ReefChannelConfigSchema.parse({ handle: "me" });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-friends-"));
    const manager = new ReefFriendManager(cfg, relay as unknown as ReefTransportClient, stateDir);

    await manager.request("alice");
    await expect(manager.reconcileApproved([])).resolves.toEqual(["alice"]);
    expect(relay.respondFriend).not.toHaveBeenCalled();
    expect(cfg.friends.alice).toMatchObject({
      autonomy: "bounded",
      ed25519PublicKey: accepted.ed25519_pub,
      keyEpoch: 1,
      safetyNumberChanged: false,
    });

    // A crash before the adopted pin is persisted must not lose authorization:
    // a rebooted manager with an empty config re-adopts from the durable marker.
    const rebooted = new ReefFriendManager(
      ReefChannelConfigSchema.parse({ handle: "me" }),
      relay as unknown as ReefTransportClient,
      stateDir,
    );
    await expect(rebooted.reconcileApproved([])).resolves.toEqual(["alice"]);

    // Once the pin is visible from persisted config, the marker is consumed;
    // afterwards a fresh config no longer auto-adopts.
    await expect(manager.reconcileApproved([])).resolves.toEqual([]);
    const postConsume = new ReefFriendManager(
      ReefChannelConfigSchema.parse({ handle: "me" }),
      relay as unknown as ReefTransportClient,
      stateDir,
    );
    await expect(postConsume.reconcileApproved([])).resolves.toEqual([]);
    expect(postConsume.config.friends).toEqual({});
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("fails closed on active relay records without a locally recorded outbound request", async () => {
    const accepted = relayFriend("alice", "active");
    accepted.initiated_by = "me";
    const relay = transport(accepted);
    const cfg = ReefChannelConfigSchema.parse({ handle: "me" });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "reef-friends-"));
    const manager = new ReefFriendManager(cfg, relay as unknown as ReefTransportClient, stateDir);

    await expect(manager.reconcileApproved([])).resolves.toEqual([]);
    expect(cfg.friends).toEqual({});
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("halts on a safety-number change and requires a later reapproval before repinning", async () => {
    const oldIdentity = generateIdentity();
    const nextIdentity = generateIdentity();
    const active = relayFriend("alice", "active", nextIdentity, 2);
    const relay = transport(active);
    const cfg = ReefChannelConfigSchema.parse({
      friends: {
        alice: {
          autonomy: "extended",
          ed25519PublicKey: oldIdentity.signing.publicKey,
          x25519PublicKey: oldIdentity.encryption.publicKey,
          keyEpoch: 1,
        },
      },
    });
    const manager = new ReefFriendManager(cfg, relay as unknown as ReefTransportClient);

    await expect(manager.reconcileApproved(["alice"])).resolves.toEqual(["alice"]);
    expect(cfg.friends.alice).toMatchObject({
      ed25519PublicKey: oldIdentity.signing.publicKey,
      keyEpoch: 1,
      safetyNumberChanged: true,
    });
    expect(relay.respondFriend).not.toHaveBeenCalled();

    active.status = "reapprove_required";
    await expect(manager.reconcileApproved([])).resolves.toEqual([]);
    expect(cfg.friends.alice!.safetyNumberChanged).toBe(true);

    await expect(manager.reconcileApproved(["alice"])).resolves.toEqual(["alice"]);
    expect(relay.respondFriend).toHaveBeenCalledWith("alice", true);
    expect(cfg.friends.alice).toMatchObject({
      autonomy: "extended",
      ed25519PublicKey: nextIdentity.signing.publicKey,
      x25519PublicKey: nextIdentity.encryption.publicKey,
      keyEpoch: 2,
      safetyNumberChanged: false,
    });
  });
});
