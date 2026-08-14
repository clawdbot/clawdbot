import type { DatabaseSync } from "node:sqlite";
import {
  clearAuditIdentityKeyCacheForDatabase,
  pseudonymizeExecutionIdentityRef,
} from "../audit/audit-identity.js";
import {
  consumeAdmittedChannelMemoryIdentity,
  type AdmittedChannelMemoryIdentity,
} from "../channels/message-access/memory-identity-admission.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { MEMORY_IDENTITY_SCHEMA_SQL } from "./memory-identity-schema.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveUserProfileId } from "./user-profiles.js";

export type MemoryIdentityBinding = Readonly<{
  bindingId: string;
  principalId: string;
  channel: string;
  accountId: string;
  adapterId: string;
  assurance: "authenticated" | "adapter-attested";
  verificationMethod: string;
  evidenceRevision: string;
  revision: string;
  expiresAt: number | null;
}>;

export type MemoryPrincipalKind =
  | "user"
  | "enterprise"
  | "service"
  | "agent"
  | "system"
  | "conversation";

export type MemoryPrincipal = Readonly<{
  principalId: string;
  kind: MemoryPrincipalKind;
  revision: string;
}>;

export type MemoryIdentityBindingCheck =
  | Readonly<{ kind: "current"; binding: MemoryIdentityBinding }>
  | Readonly<{ kind: "unbound" | "revoked" | "expired" | "conflicting" | "merge-head-mismatch" }>;

const ensuredDatabases = new WeakSet<DatabaseSync>();

// Kept as the narrow lazy-ensure primitive for the receipt table. The full
// canonical declaration remains in openclaw-state-schema.sql; this runs inside
// pairing's existing transaction so request and receipt cannot diverge.
const MEMORY_PAIRING_RECEIPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_pairing_identity_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY,
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_identity_hmac TEXT NOT NULL,
  sender_lookup_hmac TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  assurance TEXT NOT NULL CHECK (assurance IN ('authenticated', 'adapter-attested')),
  verification_method TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  binding_id TEXT,
  FOREIGN KEY (binding_id) REFERENCES memory_identity_bindings(binding_id),
  UNIQUE (channel, account_id, request_identity_hmac)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_memory_pairing_identity_receipts_pending
  ON memory_pairing_identity_receipts(channel, account_id, request_identity_hmac, expires_at)
  WHERE consumed_at IS NULL;`;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function lookupHmac(db: DatabaseSync, channel: string, accountId: string, stableSenderId: string) {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind: "principal",
    scope: `memory-identity:v1:${channel}\u0000${accountId}`,
    value: stableSenderId,
  });
}

function pairingRequestLookupHmac(
  db: DatabaseSync,
  channel: string,
  accountId: string,
  requestId: string,
  createdAt: string,
) {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind: "principal",
    scope: `memory-identity:pairing-request:v1:${channel}\u0000${accountId}`,
    value: `${requestId}\u0000${createdAt}`,
  });
}

function principalLookupHmac(db: DatabaseSync, kind: MemoryPrincipalKind, stableRef: string) {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind: "principal",
    scope: `memory-principal:v1:${kind}`,
    value: stableRef,
  });
}

function requirePrincipalKind(value: string): MemoryPrincipalKind {
  if (
    value === "user" ||
    value === "enterprise" ||
    value === "service" ||
    value === "agent" ||
    value === "system" ||
    value === "conversation"
  ) {
    return value;
  }
  throw new TypeError("memory principal kind is invalid");
}

/** Create the additive shared identity tables only on their first feature use. */
export function ensureMemoryIdentitySchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => db.exec(MEMORY_IDENTITY_SCHEMA_SQL), options, {
    operationLabel: "memory-identity.schema.ensure",
  });
  ensuredDatabases.add(database.db);
}

function ensureMemoryIdentitySchemaInTransaction(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("memory_pairing_identity_receipts") as { present: number } | undefined;
  if (!table) {
    db.exec(MEMORY_IDENTITY_SCHEMA_SQL);
    db.exec(MEMORY_PAIRING_RECEIPT_SCHEMA_SQL);
  }
}

function toBinding(row: {
  binding_id: string;
  principal_id: string;
  channel: string;
  account_id: string;
  adapter_id: string;
  assurance: "authenticated" | "adapter-attested";
  verification_method: string;
  evidence_revision: string;
  revision: string;
  expires_at: number | null;
}): MemoryIdentityBinding {
  return Object.freeze({
    bindingId: row.binding_id,
    principalId: row.principal_id,
    channel: row.channel,
    accountId: row.account_id,
    adapterId: row.adapter_id,
    assurance: row.assurance,
    verificationMethod: row.verification_method,
    evidenceRevision: row.evidence_revision,
    revision: row.revision,
    expiresAt: row.expires_at,
  });
}

function toPrincipal(row: {
  principal_id: string;
  principal_kind: string;
  revision: string;
}): MemoryPrincipal {
  return Object.freeze({
    principalId: row.principal_id,
    kind: requirePrincipalKind(row.principal_kind),
    revision: row.revision,
  });
}

/**
 * Creates or resolves a non-user canonical principal without retaining its
 * provider or local source identifier. The caller supplies only a stable
 * core-owned reference, which is reduced to a scoped keyed HMAC before write.
 */
export function ensureMemoryOperationalPrincipal(params: {
  kind: Exclude<MemoryPrincipalKind, "user" | "enterprise">;
  stableRef: string;
  principalId?: string;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal {
  const options = params.options ?? {};
  const kind = params.kind;
  const stableRef = requireText(params.stableRef, "stableRef");
  ensureMemoryIdentitySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const lookup = principalLookupHmac(db, kind, stableRef);
      const existing = db
        .prepare(
          `SELECT principal_id, principal_kind, revision
           FROM memory_principals
           WHERE principal_kind = ? AND principal_lookup_hmac = ? AND state = 'active'`,
        )
        .get(kind, lookup) as
        | { principal_id: string; principal_kind: string; revision: string }
        | undefined;
      if (existing) {
        return toPrincipal(existing);
      }
      const principal = {
        principal_id: params.principalId
          ? requireText(params.principalId, "principalId")
          : generateSecureUuid(),
        principal_kind: kind,
        revision: generateSecureUuid(),
      };
      db.prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, ?, NULL, ?, 'active', ?, ?, NULL)`,
      ).run(
        principal.principal_id,
        principal.principal_kind,
        lookup,
        principal.revision,
        Date.now(),
      );
      return toPrincipal(principal);
    },
    options,
    { operationLabel: "memory-identity.operational-principal" },
  );
}

/** Re-read a non-user canonical principal before protected memory access. */
export function recheckMemoryOperationalPrincipal(params: {
  principalId: string;
  kind: Exclude<MemoryPrincipalKind, "user" | "enterprise">;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal | undefined {
  const options = params.options ?? {};
  ensureMemoryIdentitySchema(options);
  const row = openOpenClawStateDatabase(options)
    .db.prepare(
      `SELECT principal_id, principal_kind, revision
       FROM memory_principals
       WHERE principal_id = ? AND principal_kind = ? AND state = 'active'`,
    )
    .get(requireText(params.principalId, "principalId"), params.kind) as
    | { principal_id: string; principal_kind: string; revision: string }
    | undefined;
  return row ? toPrincipal(row) : undefined;
}

/**
 * The only binding writer. Pairing admission supplies a one-use opaque proof;
 * a separately authenticated Gateway profile supplies the operator identity.
 */
export function adminLinkAdmittedMemoryIdentity(params: {
  admission: AdmittedChannelMemoryIdentity;
  authenticatedOperatorProfileId: string;
  /** Explicit target; the authenticated operator remains creation provenance. */
  targetProfileId: string;
  authenticatedOperatorScopes: readonly string[];
  expiresAt?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryIdentityBinding {
  const options = params.options ?? {};
  // This is the Gateway's closed administrative authority, kept as a literal
  // here so the shared-state owner does not depend on Gateway runtime modules.
  if (!params.authenticatedOperatorScopes.includes("operator.admin")) {
    throw new Error("memory identity admin-link requires gateway scope: operator.admin");
  }
  const requestedOperatorProfileId = requireText(
    params.authenticatedOperatorProfileId,
    "authenticatedOperatorProfileId",
  );
  if (!resolveUserProfileId(requestedOperatorProfileId, options)) {
    throw new Error("authenticated Gateway profile is unavailable");
  }
  const requestedTargetProfileId = requireText(params.targetProfileId, "targetProfileId");
  if (!resolveUserProfileId(requestedTargetProfileId, options)) {
    throw new Error("memory identity target Gateway profile is unavailable");
  }
  const admitted = consumeAdmittedChannelMemoryIdentity(params.admission);
  if (!admitted) {
    throw new Error("memory identity admin-link requires an admitted authenticated channel proof");
  }
  ensureMemoryIdentitySchema(options);
  let transactionDatabase: DatabaseSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        transactionDatabase = db;
        const now = Date.now();
        // Profile aliases can merge after gateway authentication. Resolve both
        // authority heads in this commit before assigning principal or audit
        // ownership, so no stale profile can receive a binding.
        const operatorProfileId = requireCurrentUserProfileInTransaction(
          db,
          requestedOperatorProfileId,
          "authenticatedOperatorProfileId",
        );
        const targetProfileId = requireCurrentUserProfileInTransaction(
          db,
          requestedTargetProfileId,
          "targetProfileId",
        );
        const existingPrincipal = db
          .prepare(
            "SELECT principal_id FROM memory_principals WHERE user_profile_id = ? AND state = 'active'",
          )
          .get(targetProfileId) as { principal_id?: string } | undefined;
        const principalId = existingPrincipal?.principal_id ?? generateSecureUuid();
        if (!existingPrincipal) {
          db.prepare(
            `INSERT INTO memory_principals
             (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
             VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
          ).run(principalId, targetProfileId, generateSecureUuid(), now);
        }
        const senderLookup = lookupHmac(
          db,
          admitted.channel,
          admitted.accountId,
          admitted.stableSenderId,
        );
        const existing = db
          .prepare(
            `SELECT binding_id, principal_id, channel, account_id, adapter_id, assurance, verification_method, evidence_revision, revision, expires_at
             FROM memory_identity_bindings
             WHERE channel = ? AND account_id = ? AND sender_lookup_hmac = ? AND revoked_at IS NULL`,
          )
          .get(admitted.channel, admitted.accountId, senderLookup) as
          | {
              binding_id: string;
              principal_id: string;
              channel: string;
              account_id: string;
              adapter_id: string;
              assurance: "authenticated" | "adapter-attested";
              verification_method: string;
              evidence_revision: string;
              revision: string;
              expires_at: number | null;
            }
          | undefined;
        if (existing) {
          if (existing.principal_id !== principalId) {
            throw new Error("memory identity sender is already linked to another principal");
          }
          return toBinding(existing);
        }
        const binding = {
          binding_id: generateSecureUuid(),
          principal_id: principalId,
          channel: admitted.channel,
          account_id: admitted.accountId,
          adapter_id: admitted.adapterId,
          assurance: admitted.assurance,
          verification_method: admitted.verificationMethod,
          evidence_revision: admitted.evidenceRevision,
          revision: generateSecureUuid(),
          expires_at:
            params.expiresAt === undefined ? null : Math.max(0, Math.trunc(params.expiresAt)),
        };
        db.prepare(
          `INSERT INTO memory_identity_bindings
           (binding_id, channel, account_id, sender_lookup_hmac, principal_id, adapter_id, assurance, verification_method, evidence_revision, created_by_profile_id, created_at, expires_at, revoked_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(
          binding.binding_id,
          binding.channel,
          binding.account_id,
          senderLookup,
          binding.principal_id,
          binding.adapter_id,
          binding.assurance,
          binding.verification_method,
          binding.evidence_revision,
          operatorProfileId,
          now,
          binding.expires_at,
          binding.revision,
        );
        return toBinding(binding);
      },
      options,
      { operationLabel: "memory-identity.admin-link" },
    );
  } catch (error) {
    if (transactionDatabase) {
      clearAuditIdentityKeyCacheForDatabase(transactionDatabase);
    }
    throw error;
  }
}

/**
 * Pairing-store-only receipt staging. Its caller owns the transaction that
 * writes the request, so a request can never survive without its exact proof.
 */
export function stageAdmittedMemoryIdentityPairingReceiptInTransaction(params: {
  db: DatabaseSync;
  admission: AdmittedChannelMemoryIdentity;
  /** Exact persisted pairing scope, independently checked against the proof. */
  channel: string;
  /** Exact persisted pairing scope, independently checked against the proof. */
  accountId: string;
  pairingRequestId: string;
  pairingRequestCreatedAt: string;
  expiresAt: number;
}): void {
  ensureMemoryIdentitySchemaInTransaction(params.db);
  const admitted = consumeAdmittedChannelMemoryIdentity(params.admission);
  if (!admitted) {
    throw new Error("memory identity pairing receipt requires admitted sender evidence");
  }
  const channel = requireText(params.channel, "channel").toLowerCase();
  const accountId = normalizeAccountId(requireText(params.accountId, "accountId"));
  if (admitted.channel !== channel || admitted.accountId !== accountId) {
    throw new Error(
      "memory identity pairing receipt scope does not match admitted sender evidence",
    );
  }
  const pairingRequestId = requireText(params.pairingRequestId, "pairingRequestId");
  const pairingRequestCreatedAt = requireText(
    params.pairingRequestCreatedAt,
    "pairingRequestCreatedAt",
  );
  const now = Date.now();
  if (!Number.isFinite(params.expiresAt) || params.expiresAt <= now) {
    throw new Error("memory identity pairing receipt expiry is invalid");
  }
  const senderLookup = lookupHmac(params.db, channel, accountId, admitted.stableSenderId);
  const requestLookup = pairingRequestLookupHmac(
    params.db,
    channel,
    accountId,
    pairingRequestId,
    pairingRequestCreatedAt,
  );
  const existing = params.db
    .prepare(
      `SELECT sender_lookup_hmac, adapter_id, assurance, verification_method, evidence_revision,
              expires_at, consumed_at
       FROM memory_pairing_identity_receipts
       WHERE channel = ? AND account_id = ? AND request_identity_hmac = ?`,
    )
    .get(channel, accountId, requestLookup) as
    | {
        sender_lookup_hmac: string;
        adapter_id: string;
        assurance: string;
        verification_method: string;
        evidence_revision: string;
        expires_at: number;
        consumed_at: number | null;
      }
    | undefined;
  if (existing) {
    if (
      existing.consumed_at !== null ||
      existing.expires_at <= now ||
      existing.sender_lookup_hmac !== senderLookup ||
      existing.adapter_id !== admitted.adapterId ||
      existing.assurance !== admitted.assurance ||
      existing.verification_method !== admitted.verificationMethod ||
      existing.evidence_revision !== admitted.evidenceRevision
    ) {
      throw new Error("memory identity pairing receipt conflicts with existing sender evidence");
    }
    return;
  }
  params.db
    .prepare(
      `INSERT INTO memory_pairing_identity_receipts
     (receipt_id, channel, account_id, request_identity_hmac, sender_lookup_hmac, adapter_id,
      assurance, verification_method, evidence_revision, created_at, expires_at, consumed_at, binding_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      generateSecureUuid(),
      channel,
      accountId,
      requestLookup,
      senderLookup,
      admitted.adapterId,
      admitted.assurance,
      admitted.verificationMethod,
      admitted.evidenceRevision,
      now,
      params.expiresAt,
    );
}

export type MemoryIdentityPairingLink = Readonly<{
  /** Current merge head selected explicitly by the approving operator. */
  targetProfileId: string;
  /** Current merge head of the authenticated approving operator. */
  createdByProfileId: string;
}>;

function requireCurrentUserProfileInTransaction(
  db: DatabaseSync,
  profileId: string,
  label: string,
): string {
  const normalized = requireText(profileId, label);
  const seen = new Set<string>();
  let current = normalized;
  while (true) {
    if (seen.has(current)) {
      throw new Error(`memory identity ${label} has an invalid merge cycle`);
    }
    seen.add(current);
    const row = db
      .prepare("SELECT id, merged_into FROM user_profiles WHERE id = ?")
      .get(current) as { id: string; merged_into: string | null } | undefined;
    if (!row) {
      throw new Error(`memory identity ${label} is unavailable`);
    }
    if (row.merged_into === null) {
      return row.id;
    }
    current = row.merged_into;
  }
}

/**
 * Consume an exact verified pairing receipt while the pairing-store
 * transaction still owns the pending request and allowlist mutation.
 */
export function linkMemoryIdentityPairingReceiptInTransaction(params: {
  db: DatabaseSync;
  channel: string;
  accountId: string;
  pairingRequestId: string;
  pairingRequestCreatedAt: string;
  link: MemoryIdentityPairingLink;
}): MemoryIdentityBinding | undefined {
  ensureMemoryIdentitySchemaInTransaction(params.db);
  const channel = requireText(params.channel, "channel").toLowerCase();
  const accountId = normalizeAccountId(requireText(params.accountId, "accountId"));
  const targetProfileId = requireCurrentUserProfileInTransaction(
    params.db,
    params.link.targetProfileId,
    "targetProfileId",
  );
  const createdByProfileId = requireCurrentUserProfileInTransaction(
    params.db,
    params.link.createdByProfileId,
    "createdByProfileId",
  );
  const requestLookup = pairingRequestLookupHmac(
    params.db,
    channel,
    accountId,
    requireText(params.pairingRequestId, "pairingRequestId"),
    requireText(params.pairingRequestCreatedAt, "pairingRequestCreatedAt"),
  );
  const now = Date.now();
  const receipt = params.db
    .prepare(
      `SELECT receipt_id, sender_lookup_hmac, adapter_id, assurance, verification_method,
              evidence_revision, expires_at, consumed_at
       FROM memory_pairing_identity_receipts
       WHERE channel = ? AND account_id = ? AND request_identity_hmac = ?`,
    )
    .get(channel, accountId, requestLookup) as
    | {
        receipt_id: string;
        sender_lookup_hmac: string;
        adapter_id: string;
        assurance: "authenticated" | "adapter-attested";
        verification_method: string;
        evidence_revision: string;
        expires_at: number;
        consumed_at: number | null;
      }
    | undefined;
  if (!receipt || receipt.consumed_at !== null) {
    return undefined;
  }
  if (receipt.expires_at <= now) {
    // Keep the request pending for a later verified ingress, but never retain
    // expired proof material after a failed targeted approval attempt.
    params.db
      .prepare(
        "DELETE FROM memory_pairing_identity_receipts WHERE receipt_id = ? AND consumed_at IS NULL",
      )
      .run(receipt.receipt_id);
    return undefined;
  }

  const existingPrincipal = params.db
    .prepare(
      "SELECT principal_id FROM memory_principals WHERE user_profile_id = ? AND state = 'active'",
    )
    .get(targetProfileId) as { principal_id: string } | undefined;
  const principalId = existingPrincipal?.principal_id ?? generateSecureUuid();
  if (!existingPrincipal) {
    params.db
      .prepare(
        `INSERT INTO memory_principals
         (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
         VALUES (?, 'user', ?, NULL, 'active', ?, ?, NULL)`,
      )
      .run(principalId, targetProfileId, generateSecureUuid(), now);
  }
  const existing = params.db
    .prepare(
      `SELECT binding_id, principal_id, channel, account_id, adapter_id, assurance, verification_method,
              evidence_revision, revision, expires_at
       FROM memory_identity_bindings
       WHERE channel = ? AND account_id = ? AND sender_lookup_hmac = ? AND revoked_at IS NULL`,
    )
    .get(channel, accountId, receipt.sender_lookup_hmac) as
    | {
        binding_id: string;
        principal_id: string;
        channel: string;
        account_id: string;
        adapter_id: string;
        assurance: "authenticated" | "adapter-attested";
        verification_method: string;
        evidence_revision: string;
        revision: string;
        expires_at: number | null;
      }
    | undefined;
  if (existing && existing.principal_id !== principalId) {
    throw new Error("memory identity sender is already linked to another principal");
  }
  const binding = existing ?? {
    binding_id: generateSecureUuid(),
    principal_id: principalId,
    channel,
    account_id: accountId,
    adapter_id: receipt.adapter_id,
    assurance: receipt.assurance,
    verification_method: receipt.verification_method,
    evidence_revision: receipt.evidence_revision,
    revision: generateSecureUuid(),
    expires_at: null,
  };
  if (!existing) {
    params.db
      .prepare(
        `INSERT INTO memory_identity_bindings
         (binding_id, channel, account_id, sender_lookup_hmac, principal_id, adapter_id, assurance,
          verification_method, evidence_revision, created_by_profile_id, created_at, expires_at, revoked_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        binding.binding_id,
        binding.channel,
        binding.account_id,
        receipt.sender_lookup_hmac,
        binding.principal_id,
        binding.adapter_id,
        binding.assurance,
        binding.verification_method,
        binding.evidence_revision,
        createdByProfileId,
        now,
        binding.revision,
      );
  }
  const consumed = params.db
    .prepare(
      "UPDATE memory_pairing_identity_receipts SET consumed_at = ?, binding_id = ? WHERE receipt_id = ? AND consumed_at IS NULL",
    )
    .run(now, binding.binding_id, receipt.receipt_id);
  if (consumed.changes !== 1) {
    throw new Error("memory identity pairing receipt was already consumed");
  }
  return toBinding(binding);
}

/** Remove stale evidence when ordinary pairing approval consumes the request. */
export function deleteMemoryIdentityPairingReceiptInTransaction(params: {
  db: DatabaseSync;
  channel: string;
  accountId: string;
  pairingRequestId: string;
  pairingRequestCreatedAt: string;
}): void {
  const receiptTable = params.db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("memory_pairing_identity_receipts") as { present: number } | undefined;
  if (!receiptTable) {
    return;
  }
  const channel = requireText(params.channel, "channel").toLowerCase();
  const accountId = normalizeAccountId(requireText(params.accountId, "accountId"));
  params.db
    .prepare(
      "DELETE FROM memory_pairing_identity_receipts WHERE channel = ? AND account_id = ? AND request_identity_hmac = ? AND consumed_at IS NULL",
    )
    .run(
      channel,
      accountId,
      pairingRequestLookupHmac(
        params.db,
        channel,
        accountId,
        requireText(params.pairingRequestId, "pairingRequestId"),
        requireText(params.pairingRequestCreatedAt, "pairingRequestCreatedAt"),
      ),
    );
}

/** Re-read the active binding and principal for each protected operation. */
export function recheckMemoryIdentityBinding(params: {
  bindingId: string;
  options?: OpenClawStateDatabaseOptions;
}): MemoryIdentityBindingCheck {
  const options = params.options ?? {};
  ensureMemoryIdentitySchema(options);
  const database = openOpenClawStateDatabase(options);
  const row = database.db
    .prepare(
      `SELECT b.binding_id, b.principal_id, b.channel, b.account_id, b.adapter_id, b.assurance, b.verification_method, b.evidence_revision, b.revision, b.expires_at,
              b.revoked_at AS binding_revoked_at, p.state AS principal_state, p.revoked_at AS principal_revoked_at,
              p.user_profile_id
       FROM memory_identity_bindings b
       JOIN memory_principals p ON p.principal_id = b.principal_id
       WHERE b.binding_id = ?`,
    )
    .get(requireText(params.bindingId, "bindingId")) as
    | {
        binding_id: string;
        principal_id: string;
        channel: string;
        account_id: string;
        adapter_id: string;
        assurance: "authenticated" | "adapter-attested";
        verification_method: string;
        evidence_revision: string;
        revision: string;
        expires_at: number | null;
        binding_revoked_at: number | null;
        principal_state: string;
        principal_revoked_at: number | null;
        user_profile_id: string;
      }
    | undefined;
  if (!row) {
    return { kind: "unbound" };
  }
  if (
    row.binding_revoked_at !== null ||
    row.principal_state !== "active" ||
    row.principal_revoked_at !== null
  ) {
    return { kind: "revoked" };
  }
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    return { kind: "expired" };
  }
  // A profile merge changes the principal's current authority head. Preserve
  // the original binding as audit provenance, but deny it until an operator
  // explicitly relinks the currently authenticated profile.
  if (resolveUserProfileId(row.user_profile_id, options) !== row.user_profile_id) {
    return { kind: "merge-head-mismatch" };
  }
  return { kind: "current", binding: toBinding(row) };
}

/**
 * Resolve the active binding from a consumed adapter proof. This is deliberately
 * core-only: raw channel ids and sender text are evidence, never an input that
 * a plugin, model, route, or display field can use to choose a principal.
 */
export function resolveMemoryIdentityBindingFromAdmission(params: {
  admission: AdmittedChannelMemoryIdentity;
  expectedChannel?: string;
  expectedAccountId?: string;
  options?: OpenClawStateDatabaseOptions;
}): MemoryIdentityBindingCheck {
  const admitted = consumeAdmittedChannelMemoryIdentity(params.admission);
  if (!admitted) {
    return { kind: "unbound" };
  }
  if (
    (params.expectedChannel && admitted.channel !== params.expectedChannel.trim().toLowerCase()) ||
    (params.expectedAccountId &&
      admitted.accountId !== normalizeAccountId(params.expectedAccountId))
  ) {
    return { kind: "unbound" };
  }
  const options = params.options ?? {};
  ensureMemoryIdentitySchema(options);
  const database = openOpenClawStateDatabase(options);
  const row = database.db
    .prepare(
      `SELECT binding_id, principal_id
       FROM memory_identity_bindings
       WHERE channel = ? AND account_id = ? AND sender_lookup_hmac = ? AND revoked_at IS NULL`,
    )
    .all(
      admitted.channel,
      admitted.accountId,
      lookupHmac(database.db, admitted.channel, admitted.accountId, admitted.stableSenderId),
    ) as { binding_id: string; principal_id: string }[];
  if (row.length === 0) {
    return { kind: "unbound" };
  }
  if (new Set(row.map((binding) => binding.principal_id)).size !== 1) {
    return { kind: "conflicting" };
  }
  return recheckMemoryIdentityBinding({ bindingId: row[0]!.binding_id, options });
}

/** Retain history while preventing all future subject authority from this binding. */
export function revokeMemoryIdentityBinding(params: {
  bindingId: string;
  options?: OpenClawStateDatabaseOptions;
}): boolean {
  const options = params.options ?? {};
  ensureMemoryIdentitySchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare(
          "UPDATE memory_identity_bindings SET revoked_at = ?, revision = ? WHERE binding_id = ? AND revoked_at IS NULL",
        )
        .run(Date.now(), generateSecureUuid(), requireText(params.bindingId, "bindingId")).changes >
      0,
    options,
    { operationLabel: "memory-identity.revoke" },
  );
}
