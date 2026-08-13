import { createHash, randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";
import type { ReefChannelConfig } from "./config-schema.js";
import { normalizeReefTarget } from "./config-schema.js";
import {
  ReefAutonomySchema,
  ReefPeerIdentitySchema,
  ReefPeerTrustSchema,
  matchesReefPeerIdentity,
  sameReefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
  type ReefPeerTrust,
} from "./friend-types.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState, RelayFriend } from "./types.js";

export const REEF_TRUST_STORE_MAX_ENTRIES = 4_096;
export const REEF_TRUST_STORE_NAMESPACE = "peer-state";
const REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE = "outbound-deliveries";
export const REEF_OUTBOUND_DELIVERY_MAX_ENTRIES = 32_768;
const REEF_RELAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const REEF_OUTBOUND_DELIVERY_TTL_MS = REEF_RELAY_RETENTION_MS * 2 + 24 * 60 * 60 * 1_000;
const REEF_PAIRING_APPROVAL_PREFIX = "reef-approval-v1:";
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MESSAGE_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ReefOutboundRequestSchema = z.record(z.uuid(), z.number().int().nonnegative());
const ReefRejectionNoticeStateSchema = z
  .object({
    lastRejectionAt: z.number().int().nonnegative(),
    lastResendAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const ReefOutboundRejectionSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    notice: ReefRejectionNoticeStateSchema.optional(),
  })
  .strict();
const ReefOutboundDeliveryBindingSchema = z
  .object({
    bodyHash: z.string().regex(SHA256_HEX_PATTERN),
    textHash: z.string().regex(SHA256_HEX_PATTERN).optional(),
    recipient: ReefPeerIdentitySchema,
  })
  .strict();
const ReefOutboundDeliverySchema = ReefOutboundDeliveryBindingSchema.extend({
  resendDisabled: z.literal(true).optional(),
  rejection: ReefOutboundRejectionSchema.optional(),
  // sentAt is absent on records written before overdue notices shipped; those
  // legacy sends age out via TTL without an overdue follow-up.
  sentAt: z.number().int().positive().optional(),
  overdueNotifiedAt: z.number().int().positive().optional(),
}).strict();
const ReefPeerStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    trust: ReefPeerTrustSchema.optional(),
    outboundRequests: ReefOutboundRequestSchema.optional(),
    rejectionNotice: ReefRejectionNoticeStateSchema.optional(),
  })
  .strict();

type ReefPeerStateSnapshot = z.infer<typeof ReefPeerStateSchema>;
type ReefOutboundDeliveryBinding = z.infer<typeof ReefOutboundDeliveryBindingSchema>;
type ReefOutboundDelivery = z.infer<typeof ReefOutboundDeliverySchema>;

type ReefTrustStores = {
  peers: PluginStateSyncKeyedStore<ReefPeerStateSnapshot>;
  deliveries: PluginStateSyncKeyedStore<z.infer<typeof ReefOutboundDeliverySchema>>;
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
    // The envelope and its receipt can each spend 30 days queued. Keep a
    // boundary margin so a delayed receipt still finds its exact send binding.
    deliveries: openStore<z.infer<typeof ReefOutboundDeliverySchema>>({
      namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
      maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
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
        ...(current.rejectionNotice ? { rejectionNotice: current.rejectionNotice } : {}),
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

  recordOutboundDelivery(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    options: { resendDisabled?: true } = {},
  ): void {
    const key = this.#deliveryKey(peer, id);
    const value = ReefOutboundDeliverySchema.parse({ ...binding, ...options, sentAt: Date.now() });
    if (!this.stores.deliveries.registerIfAbsent(key, value)) {
      throw new Error(`Duplicate outbound Reef delivery id ${id}`);
    }
  }

  /**
   * Sends that never produced any receipt. Rejections have their own notice
   * path, and each delivery is reported overdue at most once.
   */
  overdueOutboundDeliveries(
    olderThanMs: number,
    now: number = Date.now(),
  ): Array<{ peer: string; id: string; sentAt: number }> {
    return this.stores.deliveries
      .entries()
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const parsed = ReefOutboundDeliverySchema.safeParse(entry.value);
        if (
          !parsed.success ||
          parsed.data.rejection ||
          parsed.data.overdueNotifiedAt !== undefined ||
          parsed.data.sentAt === undefined ||
          parsed.data.sentAt + olderThanMs > now
        ) {
          return [];
        }
        const separator = entry.key.lastIndexOf(":");
        const peer = requirePeer(entry.key.slice(this.#prefix.length, separator));
        const id = entry.key.slice(separator + 1);
        if (
          !MESSAGE_ID_PATTERN.test(id) ||
          !matchesReefPeerIdentity(this.get(peer), parsed.data.recipient)
        ) {
          return [];
        }
        return [{ peer, id, sentAt: parsed.data.sentAt }];
      });
  }

  markOutboundDeliveryOverdueNotified(peer: string, id: string): boolean {
    const update = this.stores.deliveries.update;
    if (!update) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state updates");
    }
    return update(this.#deliveryKey(peer, id), (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (!parsed.success || parsed.data.rejection || parsed.data.overdueNotifiedAt !== undefined) {
        return undefined;
      }
      return { ...parsed.data, overdueNotifiedAt: Date.now() };
    });
  }

  outboundDelivery(
    peer: string,
    id: string,
  ): z.infer<typeof ReefOutboundDeliverySchema> | undefined {
    const value = this.stores.deliveries.lookup(this.#deliveryKey(peer, id));
    return value === undefined ? undefined : ReefOutboundDeliverySchema.parse(value);
  }

  consumeOutboundDelivery(peer: string, id: string, binding: ReefOutboundDeliveryBinding): boolean {
    const expected = this.#parseDeliveryBinding(binding);
    const deleteIf = this.stores.deliveries.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state deletion");
    }
    return deleteIf(this.#deliveryKey(peer, id), (current) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(current);
      return (
        parsed.success &&
        this.#matchesDeliveryBinding(parsed.data, expected) &&
        parsed.data.rejection === undefined
      );
    });
  }

  discardOutboundDelivery(peer: string, id: string, binding: ReefOutboundDeliveryBinding): boolean {
    const expected = this.#parseDeliveryBinding(binding);
    const deleteIf = this.stores.deliveries.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state deletion");
    }
    return deleteIf(this.#deliveryKey(peer, id), (current) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(current);
      return parsed.success && this.#matchesDeliveryBinding(parsed.data, expected);
    });
  }

  recordOutboundRejection(
    peer: string,
    id: string,
    binding: ReefOutboundDeliveryBinding,
    category?: string,
  ): boolean {
    const key = this.#deliveryKey(peer, id);
    const expected = this.#parseDeliveryBinding(binding);
    const current = this.outboundDelivery(peer, id);
    if (!current || !this.#matchesDeliveryBinding(current, expected)) {
      return false;
    }
    if (current.rejection) {
      return true;
    }
    const update = this.stores.deliveries.update;
    if (!update) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state updates");
    }
    return update(key, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (!parsed.success || !this.#matchesDeliveryBinding(parsed.data, expected)) {
        return undefined;
      }
      if (parsed.data.rejection) {
        return parsed.data;
      }
      const rejection = ReefOutboundRejectionSchema.parse({
        ...(category ? { category } : {}),
        ...(parsed.data.resendDisabled ? { notice: { lastRejectionAt: Date.now() } } : {}),
      });
      return { ...parsed.data, rejection };
    });
  }

  pendingOutboundRejections(): ReefDeliveryRejection[] {
    return this.stores.deliveries
      .entries()
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const delivery = ReefOutboundDeliverySchema.parse(entry.value);
        if (!delivery.rejection) {
          return [];
        }
        const separator = entry.key.lastIndexOf(":");
        const peer = requirePeer(entry.key.slice(this.#prefix.length, separator));
        const id = entry.key.slice(separator + 1);
        if (
          !MESSAGE_ID_PATTERN.test(id) ||
          !matchesReefPeerIdentity(this.get(peer), delivery.recipient)
        ) {
          return [];
        }
        return [
          {
            id,
            peer,
            recipient: delivery.recipient,
            ...(delivery.textHash ? { textHash: delivery.textHash } : {}),
            ...(delivery.rejection.category ? { category: delivery.rejection.category } : {}),
            ...(delivery.rejection.notice ? { reservedNotice: delivery.rejection.notice } : {}),
          },
        ];
      })
      .toSorted((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1));
  }

  reserveOutboundRejectionNotice(
    peer: string,
    id: string,
    recipient: ReefPeerIdentity,
    state: ReefRejectionNoticeState,
  ): { kind: "reserved" } | { kind: "existing"; state: ReefRejectionNoticeState } {
    const update = this.stores.deliveries.update;
    if (!update) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state updates");
    }
    const expectedRecipient = ReefPeerIdentitySchema.parse(recipient);
    if (!matchesReefPeerIdentity(this.get(peer), expectedRecipient)) {
      throw new Error(`Reef peer @${requirePeer(peer)} changed keys before rejection recovery`);
    }
    const noticeState = ReefRejectionNoticeStateSchema.parse(state);
    let outcome:
      | { kind: "reserved" }
      | { kind: "existing"; state: ReefRejectionNoticeState }
      | undefined;
    const updated = update(this.#deliveryKey(peer, id), (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      if (
        !parsed.success ||
        !parsed.data.rejection ||
        !sameReefPeerIdentity(parsed.data.recipient, expectedRecipient)
      ) {
        return undefined;
      }
      if (parsed.data.rejection.notice) {
        outcome = { kind: "existing", state: parsed.data.rejection.notice };
        return parsed.data;
      }
      outcome = { kind: "reserved" };
      return {
        ...parsed.data,
        rejection: {
          ...parsed.data.rejection,
          notice: noticeState,
        },
      };
    });
    if (!updated || !outcome) {
      throw new Error(`Reef rejection ${id} lost its durable delivery state`);
    }
    return outcome;
  }

  completeOutboundRejection(peer: string, id: string, state: ReefRejectionNoticeState): boolean {
    const noticeState = ReefRejectionNoticeStateSchema.parse(state);
    this.#requireUpdate()(this.#key(peer), (value) => {
      const current = this.#parseState(value);
      const previous = current.rejectionNotice;
      const hasResendAt =
        previous?.lastResendAt !== undefined || noticeState.lastResendAt !== undefined;
      return {
        ...current,
        rejectionNotice: {
          lastRejectionAt: Math.max(previous?.lastRejectionAt ?? 0, noticeState.lastRejectionAt),
          ...(hasResendAt
            ? {
                lastResendAt: Math.max(previous?.lastResendAt ?? 0, noticeState.lastResendAt ?? 0),
              }
            : {}),
        },
      };
    });
    const key = this.#deliveryKey(peer, id);
    const deleteIf = this.stores.deliveries.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef outbound delivery state requires atomic plugin-state deletion");
    }
    const deleted = deleteIf(key, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      return parsed.success && parsed.data.rejection?.notice !== undefined;
    });
    return deleted || this.stores.deliveries.lookup(key) === undefined;
  }

  rejectionNoticeState(peer: string): ReefRejectionNoticeState | undefined {
    return this.snapshot(peer).rejectionNotice;
  }

  #key(peer: string): string {
    return `${this.#prefix}${requirePeer(peer)}`;
  }

  #deliveryKey(peer: string, id: string): string {
    if (!MESSAGE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid Reef delivery id: ${id}`);
    }
    return `${this.#prefix}${requirePeer(peer)}:${id}`;
  }

  #parseState(value: ReefPeerStateSnapshot | undefined): ReefPeerStateSnapshot {
    return value === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(value);
  }

  #parseDeliveryBinding(binding: ReefOutboundDeliveryBinding): ReefOutboundDeliveryBinding {
    return ReefOutboundDeliveryBindingSchema.parse({
      bodyHash: binding.bodyHash,
      ...(binding.textHash ? { textHash: binding.textHash } : {}),
      recipient: binding.recipient,
    });
  }

  #matchesDeliveryBinding(
    current: ReefOutboundDelivery,
    expected: ReefOutboundDeliveryBinding,
  ): boolean {
    return (
      current.bodyHash === expected.bodyHash &&
      current.textHash === expected.textHash &&
      sameReefPeerIdentity(current.recipient, expected.recipient)
    );
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
