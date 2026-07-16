import { createHash, randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";
import type { ReefChannelConfig } from "./config-schema.js";
import { normalizeReefTarget } from "./config-schema.js";
import {
  ReefAutonomySchema,
  ReefPeerTrustSchema,
  type ReefAutonomy,
  type ReefPeerTrust,
} from "./friend-types.js";
import type { RelayFriend } from "./types.js";

export const REEF_TRUST_STORE_MAX_ENTRIES = 4_096;
export const REEF_TRUST_STORE_NAMESPACE = "peer-state";
const REEF_PAIRING_APPROVAL_PREFIX = "reef-approval-v1:";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const ReefOutboundRequestSchema = z.record(z.uuid(), z.number().int().nonnegative());

const ReefPeerStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    trust: ReefPeerTrustSchema.optional(),
    outboundRequests: ReefOutboundRequestSchema.optional(),
  })
  .strict();

type ReefPeerStateSnapshot = z.infer<typeof ReefPeerStateSchema>;

type ReefTrustStores = {
  peers: PluginStateSyncKeyedStore<ReefPeerStateSnapshot>;
};

function requirePeer(raw: string): string {
  const peer = normalizeReefTarget(raw);
  if (!peer) {
    throw new Error(`Invalid Reef peer handle: ${raw}`);
  }
  return peer;
}

function resolveReefIdentityScope(config: ReefChannelConfig): string {
  if (!config.handle) {
    throw new Error("Reef handle is required before opening peer trust state");
  }
  // Reef addresses one origin-wide /v1 API; config rejects path/query variants.
  // A different relay origin or handle can never inherit another claw's pins.
  return createHash("sha256")
    .update(`${new URL(config.relayUrl).origin}\n${config.handle}`)
    .digest("hex");
}

export function resolveReefTrustStoreKey(config: ReefChannelConfig, peer: string): string {
  return `${resolveReefIdentityScope(config)}:${requirePeer(peer)}`;
}

function resolvePairingKeyDigest(friend: RelayFriend, trustRevision: number): string {
  return createHash("sha256")
    .update(
      `${friend.peer}\n${friend.key_epoch}\n${trustRevision}\n${friend.ed25519_pub}\n${friend.x25519_pub}`,
    )
    .digest("hex");
}

export function isReefPairingApprovalToken(raw: string): boolean {
  return raw.trim().startsWith(REEF_PAIRING_APPROVAL_PREFIX);
}

function openStores(openStore: PluginRuntime["state"]["openSyncKeyedStore"]): ReefTrustStores {
  return {
    peers: openStore<ReefPeerStateSnapshot>({
      namespace: REEF_TRUST_STORE_NAMESPACE,
      maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  };
}

/** Canonical local Reef authorization state for one relay identity. */
export class ReefTrustStore {
  readonly #identityScope: string;
  readonly #prefix: string;

  constructor(
    readonly stores: ReefTrustStores,
    config: ReefChannelConfig,
  ) {
    this.#identityScope = resolveReefIdentityScope(config);
    this.#prefix = `${this.#identityScope}:`;
  }

  snapshot(peer: string): ReefPeerStateSnapshot {
    const value = this.stores.peers.lookup(this.#key(peer));
    return value === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(value);
  }

  get(peer: string): ReefPeerTrust | undefined {
    return this.snapshot(peer).trust;
  }

  list(): Array<{ peer: string; trust: ReefPeerTrust }> {
    return this.stores.peers
      .entries()
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const state = ReefPeerStateSchema.parse(entry.value);
        return state.trust
          ? [
              {
                peer: requirePeer(entry.key.slice(this.#prefix.length)),
                trust: state.trust,
              },
            ]
          : [];
      })
      .toSorted((left, right) => (left.peer === right.peer ? 0 : left.peer < right.peer ? -1 : 1));
  }

  set(peer: string, trust: ReefPeerTrust): void {
    const parsedTrust = ReefPeerTrustSchema.parse(trust);
    this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      return { ...current, revision: current.revision + 1, trust: parsedTrust };
    });
  }

  remove(peer: string): boolean {
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      // Keep a revision tombstone: a reconcile that started before this local
      // revocation must never recreate trust from its stale relay snapshot.
      return { revision: current.revision + 1 };
    });
  }

  setAutonomy(peer: string, autonomy: ReefAutonomy): void {
    const normalizedAutonomy = ReefAutonomySchema.parse(autonomy);
    const key = this.#key(peer);
    const changed = this.#requireUpdate()(key, (value) => {
      const current = this.#parseState(value);
      if (!current.trust) {
        return undefined;
      }
      return {
        ...current,
        trust: { ...current.trust, autonomy: normalizedAutonomy },
      };
    });
    if (!changed) {
      throw new Error(`Reef peer @${requirePeer(peer)} is not locally trusted`);
    }
  }

  markSafetyNumberChanged(peer: string, expectedRevision: number): boolean {
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      if (current.revision !== expectedRevision || !current.trust) {
        return undefined;
      }
      return {
        ...current,
        revision: current.revision + 1,
        trust: { ...current.trust, safetyNumberChanged: true },
      };
    });
  }

  commitPeerTrust(
    friend: RelayFriend,
    options: { expectedRevision: number; expectedOutboundRequestId?: string },
    approvedAt = Date.now(),
  ): boolean {
    const peer = requirePeer(friend.peer);
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      if (
        current.revision !== options.expectedRevision ||
        (options.expectedOutboundRequestId !== undefined &&
          current.outboundRequests?.[options.expectedOutboundRequestId] === undefined)
      ) {
        return undefined;
      }
      return {
        revision: current.revision + 1,
        trust: {
          autonomy: current.trust?.autonomy ?? "bounded",
          ed25519PublicKey: friend.ed25519_pub,
          x25519PublicKey: friend.x25519_pub,
          keyEpoch: friend.key_epoch,
          safetyNumberChanged: false,
          approvedAt,
        },
      };
    });
  }

  createPairingApproval(
    friend: RelayFriend,
    trustRevision = this.snapshot(friend.peer).revision,
  ): string {
    return `${REEF_PAIRING_APPROVAL_PREFIX}${this.#identityScope}:${requirePeer(friend.peer)}:${friend.key_epoch}:${trustRevision}:${resolvePairingKeyDigest(friend, trustRevision)}`;
  }

  parsePairingApproval(
    raw: string,
  ): { peer: string; keyEpoch: number; trustRevision: number } | undefined {
    const parts = raw.trim().split(":");
    if (parts.length !== 6 || `${parts[0]}:` !== REEF_PAIRING_APPROVAL_PREFIX) {
      return undefined;
    }
    const [, identityScope, rawPeer, rawKeyEpoch, rawTrustRevision, keyDigest] = parts;
    const peer = rawPeer ? normalizeReefTarget(rawPeer) : undefined;
    const keyEpoch = Number(rawKeyEpoch);
    const trustRevision = Number(rawTrustRevision);
    if (
      identityScope !== this.#identityScope ||
      !peer ||
      peer !== rawPeer ||
      !Number.isSafeInteger(keyEpoch) ||
      keyEpoch < 1 ||
      String(keyEpoch) !== rawKeyEpoch ||
      !Number.isSafeInteger(trustRevision) ||
      trustRevision < 0 ||
      String(trustRevision) !== rawTrustRevision ||
      !keyDigest ||
      !SHA256_HEX_PATTERN.test(keyDigest)
    ) {
      return undefined;
    }
    return { peer, keyEpoch, trustRevision };
  }

  matchesPairingApproval(raw: string, friend: RelayFriend): boolean {
    return raw.trim() === this.createPairingApproval(friend);
  }

  recordOutboundRequest(peer: string, requestedAt = Date.now()): string {
    const requestId = randomUUID();
    const recorded = this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      return {
        ...current,
        outboundRequests: { ...current.outboundRequests, [requestId]: requestedAt },
      };
    });
    if (!recorded) {
      throw new Error(`Failed to persist outbound Reef request for @${requirePeer(peer)}`);
    }
    return requestId;
  }

  hasOutboundRequest(peer: string): boolean {
    return Object.keys(this.snapshot(peer).outboundRequests ?? {}).length > 0;
  }

  outboundRequestStatus(peer: string, requestId: string): "current" | "superseded" | "revoked" {
    const current = this.snapshot(peer);
    if (current.outboundRequests?.[requestId] !== undefined) {
      return "current";
    }
    return current.trust || this.#hasOutboundRequests(current) ? "superseded" : "revoked";
  }

  removeOutboundRequest(peer: string, requestId?: string): boolean {
    return this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      if (!this.#hasOutboundRequests(current)) {
        return undefined;
      }
      if (requestId === undefined) {
        const { outboundRequests: _removed, ...next } = current;
        return next;
      }
      if (current.outboundRequests?.[requestId] === undefined) {
        return undefined;
      }
      const { [requestId]: _removed, ...remaining } = current.outboundRequests;
      if (Object.keys(remaining).length === 0) {
        const { outboundRequests: _allRemoved, ...next } = current;
        return next;
      }
      return { ...current, outboundRequests: remaining };
    });
  }

  #key(peer: string): string {
    return `${this.#prefix}${requirePeer(peer)}`;
  }

  #parseState(value: ReefPeerStateSnapshot | undefined): ReefPeerStateSnapshot {
    return value === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(value);
  }

  #hasOutboundRequests(state: ReefPeerStateSnapshot): boolean {
    return Object.keys(state.outboundRequests ?? {}).length > 0;
  }

  #requireUpdate(): NonNullable<PluginStateSyncKeyedStore<ReefPeerStateSnapshot>["update"]> {
    const update = this.stores.peers.update;
    if (!update) {
      throw new Error("Reef peer trust requires atomic plugin-state updates");
    }
    return update;
  }
}

export function openReefTrustStore(
  runtime: PluginRuntime,
  config: ReefChannelConfig,
): ReefTrustStore {
  return new ReefTrustStore(openStores(runtime.state.openSyncKeyedStore), config);
}
