import { createHash, randomUUID } from "node:crypto";
import { gcm } from "@noble/ciphers/aes.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  base64,
  base64url,
  canonicalBytes,
  decodeUtf8,
  fromBase64,
  fromBase64url,
  generateIdentity,
  REEF_ENVELOPE_MAX_AGE_SECONDS,
  validateMessageBody,
  type CompletedReplay,
  type MessageBody,
  type ReplayClaim,
  type ReplayStore,
  type ReviewApproval,
  type ReviewRequest,
  type SignedReceipt,
} from "../protocol/index.js";
import { openReefAuditStore } from "./audit-state.js";
import { loadReefIdentityBinding, type ReefIdentityBinding } from "./registration-state.js";
import type { ReefKeys } from "./types.js";

export * from "./audit-state.js";
export * from "./registration-state.js";

export const REEF_KEYS_NAMESPACE = "identity";
export const REEF_KEYS_KEY = "keys";
export const REEF_KEYS_MAX_ENTRIES = 1;
export const REEF_KEYS_MIGRATION_NAMESPACE = "identity-migration";
export const REEF_KEYS_MIGRATION_KEY = "keys-json";
export const REEF_KEYS_MIGRATION_MAX_ENTRIES = 1;
export const REEF_DURABLE_MIGRATION_NAMESPACE = "durable-migration";
export const REEF_DURABLE_MIGRATION_KEY = "legacy-files";
export const REEF_DURABLE_MIGRATION_MAX_ENTRIES = 1;
export const REEF_REPLAY_NAMESPACE = "replay";
export const REEF_REPLAY_MAX_ENTRIES = 3_000;
export const REEF_REPLAY_TTL_MS = (REEF_ENVELOPE_MAX_AGE_SECONDS + 24 * 60 * 60) * 1_000;
export const REEF_REVIEWS_NAMESPACE = "reviews";
export const REEF_REVIEWS_MAX_ENTRIES = 2_000;
export const REEF_DELIVERED_NAMESPACE = "delivered";
export const REEF_DELIVERED_MAX_ENTRIES = 5_000;
export const REEF_DELIVERED_TTL_MS = REEF_REPLAY_TTL_MS;
const REEF_INBOX_CURSOR_NAMESPACE = "inbox-cursor";
const REEF_INBOX_CURSOR_KEY = "current";
const REEF_INBOX_CURSOR_MAX_ENTRIES = 1;

export type ReefReplayRecord = {
  peer: string;
  id: string;
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  claimOwner?: string;
  claimExpiresAt?: number;
  receipt?: SignedReceipt;
  body?: { enc: string };
};

const REEF_REPLAY_CLAIM_LEASE_MS = 5 * 60_000;

export type ReefReviewRecord = { review: ReviewRequest; approved?: boolean };

export type ReefIdentityMigrationRecord = {
  pending: true;
  identityBindingRequired: boolean;
};
export type ReefDurableMigrationRecord = { pending: true };

export function parseReefKeys(value: unknown): ReefKeys {
  if (!value || typeof value !== "object") {
    throw new Error("invalid Reef keys");
  }
  const keys = value as ReefKeys;
  if (
    fromBase64url(keys.signing?.publicKey ?? "").length !== 32 ||
    fromBase64url(keys.signing?.secretKey ?? "").length !== 32 ||
    fromBase64url(keys.encryption?.publicKey ?? "").length !== 32 ||
    fromBase64url(keys.encryption?.secretKey ?? "").length !== 32 ||
    fromBase64url(keys.auditKey ?? "").length !== 32 ||
    fromBase64url(keys.replayKey ?? "").length !== 32 ||
    !Number.isSafeInteger(keys.keyEpoch) ||
    keys.keyEpoch < 1
  ) {
    throw new Error("invalid Reef keys");
  }
  return structuredClone(keys);
}

function openKeysStore(runtime: PluginRuntime): PluginStateSyncKeyedStore<ReefKeys> {
  return runtime.state.openSyncKeyedStore<ReefKeys>({
    namespace: REEF_KEYS_NAMESPACE,
    maxEntries: REEF_KEYS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function assertReefIdentityMigrationComplete(runtime: PluginRuntime): void {
  const durableMigration = runtime.state.openSyncKeyedStore<ReefDurableMigrationRecord>({
    namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
    maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  if (durableMigration.lookup(REEF_DURABLE_MIGRATION_KEY)) {
    throw new Error(
      "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix",
    );
  }
  const migration = runtime.state.openSyncKeyedStore<ReefIdentityMigrationRecord>({
    namespace: REEF_KEYS_MIGRATION_NAMESPACE,
    maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  if (migration.lookup(REEF_KEYS_MIGRATION_KEY)) {
    throw new Error(
      "Reef identity migration is incomplete; repair the legacy identity files and rerun openclaw doctor --fix",
    );
  }
}

export async function generateAndStoreKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  assertReefIdentityMigrationComplete(runtime);
  const binding = loadReefIdentityBinding(runtime);
  if (binding) {
    throw new Error(
      `Reef identity @${binding.handle} on ${binding.relayUrl} has no canonical keys; restore the original keys before registration`,
    );
  }
  const identity = generateIdentity();
  const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
  const keys: ReefKeys = {
    ...identity,
    auditKey: base64url(random(32)),
    replayKey: base64url(random(32)),
    keyEpoch: 1,
  };
  if (!openKeysStore(runtime).registerIfAbsent(REEF_KEYS_KEY, keys)) {
    throw new Error("Reef keys already exist in plugin state");
  }
  return keys;
}

export async function loadKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  assertReefIdentityMigrationComplete(runtime);
  const value = openKeysStore(runtime).lookup(REEF_KEYS_KEY);
  if (!value) {
    const error = new Error("Reef keys are missing from plugin state") as Error & {
      code?: string;
    };
    error.code = "ENOENT";
    throw error;
  }
  return parseReefKeys(value);
}

export function reefReplayStoreKey(peer: string, id: string): string {
  return `binding:${createHash("sha256")
    .update(JSON.stringify([peer, id]))
    .digest("hex")}`;
}

function parseReplayRecord(value: ReefReplayRecord | undefined): ReefReplayRecord | undefined {
  if (!value) {
    return undefined;
  }
  if (
    typeof value.peer !== "string" ||
    typeof value.id !== "string" ||
    typeof value.envelopeHash !== "string" ||
    !["available", "in_flight", "completed", "consumed"].includes(value.state) ||
    (value.state === "in_flight" &&
      (typeof value.claimOwner !== "string" ||
        value.claimOwner.length === 0 ||
        !Number.isSafeInteger(value.claimExpiresAt) ||
        (value.claimExpiresAt ?? 0) <= 0))
  ) {
    throw new Error("invalid Reef replay state");
  }
  return value;
}

function encryptReplayBody(
  body: MessageBody,
  key: Uint8Array,
  rng: (length: number) => Uint8Array,
): { enc: string } {
  validateMessageBody(body);
  const nonce = rng(12);
  if (nonce.length !== 12) {
    throw new Error("replay body rng returned invalid nonce");
  }
  return { enc: base64(concatBytes(nonce, gcm(key, nonce).encrypt(canonicalBytes(body)))) };
}

function decryptReplayBody(body: { enc: string }, key: Uint8Array): MessageBody {
  const packed = fromBase64(body.enc);
  if (packed.length < 28) {
    throw new Error("invalid encrypted replay body");
  }
  const value = JSON.parse(
    decodeUtf8(gcm(key, packed.slice(0, 12)).decrypt(packed.slice(12))),
  ) as unknown;
  validateMessageBody(value);
  return value;
}

function validateReplayCompletion(receipt: SignedReceipt, body: MessageBody | undefined): void {
  if ((receipt.status === "accepted") !== (body !== undefined)) {
    throw new Error("accepted replay completion requires body; rejected completion forbids body");
  }
}

class ReefSqliteReplayStore implements ReplayStore {
  readonly #bodyKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #store: PluginStateSyncKeyedStore<ReefReplayRecord>;
  readonly #claimOwners = new Map<string, string>();

  constructor(
    runtime: PluginRuntime,
    bodyKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
    maxEntries = REEF_REPLAY_MAX_ENTRIES,
  ) {
    if (bodyKey.length !== 32) {
      throw new Error("replay body key must be 32 bytes");
    }
    this.#bodyKey = bodyKey.slice();
    this.#rng = rng;
    this.#store = runtime.state.openSyncKeyedStore<ReefReplayRecord>({
      namespace: REEF_REPLAY_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
      // Once this expires, the protocol rejects the original envelope by age.
      // The margin covers clock skew and delayed local processing.
      defaultTtlMs: REEF_REPLAY_TTL_MS,
    });
  }

  #update(
    peer: string,
    id: string,
    updateValue: (current: ReefReplayRecord | undefined) => ReefReplayRecord | undefined,
  ): boolean {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef replay state requires atomic plugin-state updates");
    }
    return update(reefReplayStoreKey(peer, id), (current) =>
      updateValue(parseReplayRecord(current)),
    );
  }

  async claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim> {
    const key = reefReplayStoreKey(peer, id);
    let result: ReplayClaim = "new";
    const owner = randomUUID();
    const claimExpiresAt = Date.now() + REEF_REPLAY_CLAIM_LEASE_MS;
    this.#update(peer, id, (existing) => {
      if (!existing) {
        return {
          peer,
          id,
          envelopeHash,
          state: "in_flight",
          claimOwner: owner,
          claimExpiresAt,
        };
      }
      if (existing.peer !== peer || existing.id !== id || existing.envelopeHash !== envelopeHash) {
        result = "mismatch";
        return existing;
      }
      if (existing.state === "completed" || existing.state === "consumed") {
        result = "duplicate";
        return existing;
      }
      if (existing.state === "in_flight" && (existing.claimExpiresAt ?? 0) > Date.now()) {
        result = "in_flight";
        return existing;
      }
      return {
        ...existing,
        state: "in_flight",
        claimOwner: owner,
        claimExpiresAt,
      };
    });
    if (result === "new") {
      this.#claimOwners.set(key, owner);
    }
    return result;
  }

  async refresh(peer: string, id: string): Promise<void> {
    const key = reefReplayStoreKey(peer, id);
    const owner = this.#claimOwners.get(key);
    let refreshed = false;
    if (owner) {
      this.#update(peer, id, (existing) => {
        if (existing?.state !== "in_flight" || existing.claimOwner !== owner) {
          return existing;
        }
        refreshed = true;
        return { ...existing, claimExpiresAt: Date.now() + REEF_REPLAY_CLAIM_LEASE_MS };
      });
    }
    if (!refreshed) {
      this.#claimOwners.delete(key);
      throw new Error("replay claim is not in flight");
    }
  }

  async complete(
    peer: string,
    id: string,
    receipt: SignedReceipt,
    body?: MessageBody,
  ): Promise<void> {
    if (receipt.id !== id) {
      throw new Error("receipt id does not match replay claim");
    }
    validateReplayCompletion(receipt, body);
    const key = reefReplayStoreKey(peer, id);
    const owner = this.#claimOwners.get(key);
    let completed = false;
    this.#update(peer, id, (existing) => {
      if (existing?.state !== "in_flight" || existing.claimOwner !== owner) {
        return existing;
      }
      completed = true;
      const { claimOwner: _claimOwner, claimExpiresAt: _claimExpiresAt, ...rest } = existing;
      return {
        ...rest,
        state: "completed",
        receipt: structuredClone(receipt),
        ...(body ? { body: encryptReplayBody(body, this.#bodyKey, this.#rng) } : {}),
      };
    });
    if (!completed) {
      throw new Error("replay claim is not in flight");
    }
    this.#claimOwners.delete(key);
  }

  async consume(peer: string, id: string): Promise<void> {
    const key = reefReplayStoreKey(peer, id);
    const owner = this.#claimOwners.get(key);
    let consumed = false;
    this.#update(peer, id, (existing) => {
      if (existing?.state !== "in_flight" || existing.claimOwner !== owner) {
        return existing;
      }
      consumed = true;
      const {
        receipt: _receipt,
        body: _body,
        claimOwner: _claimOwner,
        claimExpiresAt: _claimExpiresAt,
        ...rest
      } = existing;
      return { ...rest, state: "consumed" };
    });
    if (!consumed) {
      throw new Error("replay claim is not in flight");
    }
    this.#claimOwners.delete(key);
  }

  async release(peer: string, id: string): Promise<void> {
    const key = reefReplayStoreKey(peer, id);
    const owner = this.#claimOwners.get(key);
    this.#update(peer, id, (existing) =>
      existing?.state === "in_flight" && existing.claimOwner === owner
        ? {
            peer: existing.peer,
            id: existing.id,
            envelopeHash: existing.envelopeHash,
            state: "available",
          }
        : existing,
    );
    this.#claimOwners.delete(key);
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    const existing = parseReplayRecord(this.#store.lookup(reefReplayStoreKey(peer, id)));
    if (
      existing?.peer !== peer ||
      existing.id !== id ||
      existing.state !== "completed" ||
      !existing.receipt
    ) {
      return undefined;
    }
    return existing.body
      ? {
          receipt: structuredClone(existing.receipt),
          body: decryptReplayBody(existing.body, this.#bodyKey),
        }
      : { receipt: structuredClone(existing.receipt) };
  }
}

export class ReviewApprovalStore {
  readonly #store: PluginStateSyncKeyedStore<ReefReviewRecord>;
  readonly #maxEntries: number;

  constructor(runtime: PluginRuntime, maxEntries = REEF_REVIEWS_MAX_ENTRIES) {
    this.#maxEntries = maxEntries;
    this.#store = runtime.state.openSyncKeyedStore<ReefReviewRecord>({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
    });
  }

  #makeRoomForPendingReview(): void {
    const deleteIf = this.#store.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef review retention requires atomic plugin-state deleteIf");
    }
    while (true) {
      const entries = this.#store.entries();
      if (entries.length < this.#maxEntries) {
        return;
      }
      const completed = entries
        .filter((entry) => entry.value.approved !== undefined)
        .toSorted((left, right) => left.createdAt - right.createdAt)[0];
      if (!completed) {
        throw new Error("Reef pending review capacity is exhausted");
      }
      deleteIf(completed.key, (current) => current.approved !== undefined);
    }
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    const current = this.#store.lookup(review.approvalDigest);
    if (current?.approved !== undefined) {
      return { approved: current.approved, approvalDigest: review.approvalDigest };
    }
    if (!current) {
      this.#makeRoomForPendingReview();
    }
    this.#store.registerIfAbsent(review.approvalDigest, { review: structuredClone(review) });
    const persisted = this.#store.lookup(review.approvalDigest);
    if (!persisted) {
      throw new Error("Failed persisting Reef pending review");
    }
    return persisted?.approved === undefined
      ? undefined
      : { approved: persisted.approved, approvalDigest: review.approvalDigest };
  }

  async decide(digest: string, approved: boolean): Promise<boolean> {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef review state requires atomic plugin-state updates");
    }
    let found = false;
    update(digest, (current) => {
      if (!current) {
        return undefined;
      }
      found = true;
      return { ...current, approved };
    });
    return found;
  }

  async list(): Promise<ReviewRequest[]> {
    return this.#store
      .entries()
      .filter((entry) => entry.value.approved === undefined)
      .map((entry) => structuredClone(entry.value.review));
  }
}

export class ReefDeliveredStore {
  readonly #store: PluginStateSyncKeyedStore<{ id: string }>;

  constructor(runtime: PluginRuntime, maxEntries = REEF_DELIVERED_MAX_ENTRIES) {
    this.#store = runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
      // Relay redelivery is bounded by the same envelope-age contract as replay.
      // Keep markers longer than that window and fail closed at live capacity.
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
  }

  async has(id: string): Promise<boolean> {
    return this.#store.lookup(id)?.id === id;
  }

  async add(id: string): Promise<void> {
    if (this.#store.lookup(id)?.id === id) {
      return;
    }
    if (!this.#store.registerIfAbsent(id, { id }) && this.#store.lookup(id)?.id !== id) {
      throw new Error("Failed persisting Reef delivered marker");
    }
  }
}

type ReefInboxCursorRecord = ReefIdentityBinding & { cursor: number };

function parseReefInboxCursorRecord(value: unknown): ReefInboxCursorRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<ReefInboxCursorRecord>;
  return typeof record.handle === "string" &&
    record.handle.length > 0 &&
    typeof record.relayUrl === "string" &&
    record.relayUrl.length > 0 &&
    Number.isSafeInteger(record.cursor) &&
    (record.cursor ?? -1) >= 0
    ? { handle: record.handle, relayUrl: record.relayUrl, cursor: record.cursor! }
    : undefined;
}

/** Durable relay progress for the single Reef identity bound to this state DB. */
export class ReefInboxCursorStore {
  readonly #store: PluginStateSyncKeyedStore<ReefInboxCursorRecord>;

  constructor(
    runtime: PluginRuntime,
    readonly binding: ReefIdentityBinding,
  ) {
    this.#store = runtime.state.openSyncKeyedStore<ReefInboxCursorRecord>({
      namespace: REEF_INBOX_CURSOR_NAMESPACE,
      maxEntries: REEF_INBOX_CURSOR_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
  }

  load(): number {
    const value = this.#store.lookup(REEF_INBOX_CURSOR_KEY);
    if (value === undefined) {
      return 0;
    }
    return this.#requireBoundRecord(value).cursor;
  }

  advance(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("invalid Reef inbox cursor");
    }
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef inbox cursor requires atomic plugin-state updates");
    }
    update(REEF_INBOX_CURSOR_KEY, (current) => {
      if (current === undefined) {
        return { ...this.binding, cursor };
      }
      const existing = this.#requireBoundRecord(current);
      return cursor > existing.cursor ? { ...existing, cursor } : existing;
    });
    const persisted = this.#store.lookup(REEF_INBOX_CURSOR_KEY);
    if (!persisted || this.#requireBoundRecord(persisted).cursor < cursor) {
      throw new Error("failed persisting Reef inbox cursor");
    }
  }

  #requireBoundRecord(value: unknown): ReefInboxCursorRecord {
    const record = parseReefInboxCursorRecord(value);
    if (!record) {
      throw new Error("invalid Reef inbox cursor state");
    }
    if (record.handle !== this.binding.handle || record.relayUrl !== this.binding.relayUrl) {
      throw new Error("Reef inbox cursor belongs to a different identity");
    }
    return record;
  }
}

export function openStores(
  runtime: PluginRuntime,
  keys: ReefKeys,
  options: {
    auditMaxEntries?: number;
    replayMaxEntries?: number;
    deliveredMaxEntries?: number;
  } = {},
) {
  assertReefIdentityMigrationComplete(runtime);
  return {
    audit: openReefAuditStore(runtime, fromBase64url(keys.auditKey), options.auditMaxEntries),
    replay: new ReefSqliteReplayStore(
      runtime,
      fromBase64url(keys.replayKey),
      randomBytes,
      options.replayMaxEntries,
    ),
    reviews: new ReviewApprovalStore(runtime),
    delivered: new ReefDeliveredStore(runtime, options.deliveredMaxEntries),
  };
}
