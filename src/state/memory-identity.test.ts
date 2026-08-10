import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeAdmittedChannelMemoryIdentityFromContext,
  createChannelMemoryIdentityAdmission,
} from "../channels/message-access/memory-identity-admission.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import {
  adminLinkAdmittedMemoryIdentity as linkAdmittedMemoryIdentity,
  recheckMemoryIdentityBinding,
  resolveMemoryIdentityBindingFromAdmission,
} from "./memory-identity.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail } from "./user-profiles.js";

const roots: string[] = [];

function adminLinkAdmittedMemoryIdentity(
  params: Omit<Parameters<typeof linkAdmittedMemoryIdentity>[0], "targetProfileId"> & {
    targetProfileId?: string;
  },
) {
  return linkAdmittedMemoryIdentity({
    ...params,
    targetProfileId: params.targetProfileId ?? params.authenticatedOperatorProfileId,
  });
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-identity-"));
  roots.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const profile = ensureProfileForEmail("operator@example.com", { env });
  return { env, profileId: profile.id };
}

function admitted(channel: string, accountId: string, stableSenderId: string) {
  const admission = createChannelMemoryIdentityAdmission({
    pluginId: channel,
    adapterId: `plugin:${channel}`,
    ownsChannel: (candidate) => candidate === channel,
    isActive: () => true,
  });
  const context = {};
  admission.attachVerifiedDirectSender({ context, channel, accountId, stableSenderId });
  const proof = consumeAdmittedChannelMemoryIdentityFromContext(context);
  if (!proof) {
    throw new Error("fixture failed to create channel admission");
  }
  return proof;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("memory identity binding", () => {
  it("opens a current-version shared database before the additive identity tables are ensured", () => {
    const { env, profileId } = fixture();
    const original = openOpenClawStateDatabase({ env });
    original.db.exec(`
      DROP TABLE IF EXISTS memory_pairing_identity_receipts;
      DROP TABLE IF EXISTS memory_identity_bindings;
      DROP TABLE IF EXISTS memory_principals;
    `);
    closeOpenClawStateDatabaseForTest();

    const reopened = openOpenClawStateDatabase({ env });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_principals'",
        )
        .get(),
    ).toBeUndefined();

    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitted("telegram", "default", "sender-lazy-schema"),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });

    expect(binding.principalId).toBeTruthy();
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_principals'",
        )
        .get(),
    ).toEqual({ name: "memory_principals" });
  });

  it("rejects expired evidence during both issuance and current-authority recheck", () => {
    const { env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitted("telegram", "default", "sender-expired"),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      expiresAt: Date.now() - 1,
      options: { env },
    });

    expect(
      recheckMemoryIdentityBinding({ bindingId: binding.bindingId, options: { env } }),
    ).toEqual({
      kind: "expired",
    });
    expect(
      resolveMemoryIdentityBindingFromAdmission({
        admission: admitted("telegram", "default", "sender-expired"),
        expectedChannel: "telegram",
        expectedAccountId: "default",
        options: { env },
      }),
    ).toEqual({ kind: "expired" });
  });

  it("fails closed when a damaged shared database contains conflicting active bindings", () => {
    const { env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitted("telegram", "default", "sender-conflict"),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    const db = openOpenClawStateDatabase({ env }).db;
    const lookup = db
      .prepare("SELECT sender_lookup_hmac FROM memory_identity_bindings WHERE binding_id = ?")
      .get(binding.bindingId) as { sender_lookup_hmac: string };
    db.exec("DROP INDEX idx_memory_identity_bindings_active_sender");
    const conflictingPrincipalId = generateSecureUuid();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_principals
       (principal_id, principal_kind, user_profile_id, principal_lookup_hmac, state, revision, created_at, revoked_at)
       VALUES (?, 'user', NULL, NULL, 'active', ?, ?, NULL)`,
    ).run(conflictingPrincipalId, generateSecureUuid(), now);
    db.prepare(
      `INSERT INTO memory_identity_bindings
       (binding_id, channel, account_id, sender_lookup_hmac, principal_id, adapter_id, assurance, verification_method, evidence_revision, created_by_profile_id, created_at, expires_at, revoked_at, revision)
       VALUES (?, 'telegram', 'default', ?, ?, 'plugin:telegram', 'adapter-attested', 'test', 'test:conflict', ?, ?, NULL, NULL, ?)`,
    ).run(
      generateSecureUuid(),
      lookup.sender_lookup_hmac,
      conflictingPrincipalId,
      profileId,
      now,
      generateSecureUuid(),
    );

    expect(
      resolveMemoryIdentityBindingFromAdmission({
        admission: admitted("telegram", "default", "sender-conflict"),
        expectedChannel: "telegram",
        expectedAccountId: "default",
        options: { env },
      }),
    ).toEqual({ kind: "conflicting" });
  });

  it("records current merge heads for both explicit target and approving operator", () => {
    const { env, profileId } = fixture();
    const operatorHead = ensureProfileForEmail("operator-head@example.com", { env });
    const targetSource = ensureProfileForEmail("target-source@example.com", { env });
    const targetHead = ensureProfileForEmail("target-head@example.com", { env });
    linkEmail("operator@example.com", operatorHead.id, { env });
    linkEmail("target-source@example.com", targetHead.id, { env });

    adminLinkAdmittedMemoryIdentity({
      admission: admitted("telegram", "default", "merged-head-sender"),
      authenticatedOperatorProfileId: profileId,
      targetProfileId: targetSource.id,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });

    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare(
          `SELECT p.user_profile_id, b.created_by_profile_id
           FROM memory_identity_bindings b
           JOIN memory_principals p ON p.principal_id = b.principal_id`,
        )
        .get(),
    ).toEqual({ user_profile_id: targetHead.id, created_by_profile_id: operatorHead.id });
  });
});
