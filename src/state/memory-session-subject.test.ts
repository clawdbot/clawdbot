import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeAdmittedChannelMemoryIdentity,
  consumeAdmittedChannelMemoryIdentityFromContext,
  createChannelMemoryIdentityAdmission,
} from "../channels/message-access/memory-identity-admission.js";
import { resolveStableChannelMessageIngress } from "../channels/message-access/runtime.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.js";
import { linkAdmittedMemoryIdentityFromGateway } from "../gateway/memory-identity-admin.js";
import {
  enableMemoryShadowReadOnlyMode,
  isMemoryIsolationSubjectAdmitted,
  resetMemoryIsolationCutoverForTest,
} from "../plugins/memory-cutover.js";
import {
  captureTrustedMemoryAccessFacts,
  createTrustedMemoryAccessContext,
  isTrustedMemoryAccessContext,
  materializeTrustedMemoryAccessContext,
  readTrustedMemoryAccessSessionContext,
} from "./memory-access-context.js";
import {
  adminLinkAdmittedMemoryIdentity as linkAdmittedMemoryIdentity,
  recheckMemoryIdentityBinding,
  revokeMemoryIdentityBinding,
} from "./memory-identity.js";
import {
  admitInboundMemorySessionContext,
  createCurrentMemorySessionContext,
  persistMemorySessionSubject,
  readInboundMemorySessionContext,
  snapshotMemorySessionSubject,
} from "./memory-session-subject.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
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

function admitMemoryIdentity(params: {
  channel: string;
  accountId: string;
  stableSenderId: string;
  adapterId: string;
  assurance: "authenticated" | "adapter-attested";
  verificationMethod: string;
  evidenceRevision: string;
}) {
  const admission = createChannelMemoryIdentityAdmission({
    pluginId: params.adapterId.replace(/^plugin:/, ""),
    adapterId: params.adapterId,
    ownsChannel: (channel) => channel === params.channel,
    isActive: () => true,
  });
  const context = {};
  admission.attachVerifiedDirectSender({
    context,
    channel: params.channel,
    accountId: params.accountId,
    stableSenderId: params.stableSenderId,
  });
  const proof = consumeAdmittedChannelMemoryIdentityFromContext(context);
  if (!proof) {
    throw new Error("fixture failed to mint admitted channel identity");
  }
  return proof;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-memory-subject-"));
  roots.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const profile = ensureProfileForEmail("operator@example.com", { env });
  const agent = openOpenClawAgentDatabase({ agentId: "main", env });
  agent.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("agent:main:direct:dm", "session-1", "{}", Date.now());
  agent.db
    .prepare(
      `INSERT INTO session_windows
       (session_id, session_key, created_at, updated_at, chat_type, channel, account_id)
       VALUES (?, ?, ?, ?, 'direct', 'telegram', 'default')`,
    )
    .run("session-1", "agent:main:direct:dm", Date.now(), Date.now());
  return { env, profileId: profile.id, agentOptions: { agentId: "main", env } };
}

afterEach(() => {
  resetMemoryIsolationCutoverForTest();
  for (const root of roots.splice(0)) {
    // Vitest owns the temporary test fixture; files stay outside repository state.
    rmSync(root, { force: true, recursive: true });
  }
});

describe("memory session subject", () => {
  it("rejects a second verified subject before it can mint a protected context in the shadow pilot", () => {
    const { agentOptions, env, profileId } = fixture();
    const alice = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "alice",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:alice",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      bindingId: alice.bindingId,
      options: agentOptions,
    });
    expect(enableMemoryShadowReadOnlyMode({ agentId: "main", options: agentOptions })).toBe(
      "shadow-read-only",
    );
    resetMemoryIsolationCutoverForTest();

    const database = openOpenClawAgentDatabase(agentOptions);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:direct:bob", "bob-session", "{}", 1);
    database.db
      .prepare(
        `INSERT INTO session_windows
         (session_id, session_key, created_at, updated_at, chat_type, channel, account_id)
         VALUES (?, ?, 1, 1, 'direct', 'telegram', 'default')`,
      )
      .run("bob-session", "agent:main:direct:bob");
    const bobProfile = ensureProfileForEmail("bob@example.com", { env });
    const bob = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "bob",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:bob",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      targetProfileId: bobProfile.id,
      options: { env },
    });
    persistMemorySessionSubject({
      sessionKey: "agent:main:direct:bob",
      sessionId: "bob-session",
      bindingId: bob.bindingId,
      options: agentOptions,
    });
    expect(
      isMemoryIsolationSubjectAdmitted({
        agentId: "main",
        subject: { kind: "user", principalId: alice.principalId },
        options: agentOptions,
      }),
    ).toBe(true);
    expect(
      isMemoryIsolationSubjectAdmitted({
        agentId: "main",
        subject: { kind: "user", principalId: bob.principalId },
        options: agentOptions,
      }),
    ).toBe(false);

    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:bob",
        sessionId: "bob-session",
        options: agentOptions,
      }),
    ).toEqual({ kind: "shadow-subject-mismatch" });
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }),
    ).toMatchObject({ kind: "current", context: { principalId: alice.principalId } });
  });

  it("consumes the loader-bound Telegram proof at the persisted session owner", () => {
    const { agentOptions, env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-1",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:1",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    const admission = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    });
    const context = {};
    admission.attachVerifiedDirectSender({
      context,
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-1",
    });

    const result = admitInboundMemorySessionContext({
      context,
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      options: agentOptions,
    });

    expect(result).toMatchObject({
      kind: "current",
      context: { bindingId: binding.bindingId, principalId: binding.principalId },
    });
    openOpenClawAgentDatabase(agentOptions)
      .db.prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
      .run("session-2", "agent:main:direct:dm");
    // An inbound handoff cannot keep using the context after the logical
    // session moved to another generation.
    expect(readInboundMemorySessionContext(context)).toBeUndefined();
  });

  it("treats caller-shaped context data and shared-main DMs as ambiguous", () => {
    const { agentOptions, env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-1",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:shared-main",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    openOpenClawAgentDatabase(agentOptions)
      .db.prepare("UPDATE session_windows SET session_scope = 'shared-main' WHERE session_id = ?")
      .run("session-1");
    const lookalike = {
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-1",
      displayName: "Trusted-looking attacker",
      aliases: ["owner"],
      identityLinks: { gatewayProfile: profileId },
      routeKey: "agent:main:private-owner",
      modelVisibleContext: { principalId: binding.principalId },
    };
    const admission = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    });
    const context = {};
    admission.attachVerifiedDirectSender({
      context,
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-1",
    });
    expect(
      admitInboundMemorySessionContext({
        context,
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(
      admitInboundMemorySessionContext({
        context: lookalike,
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(binding.bindingId).toBeTruthy();
  });

  it.each(["group", "channel"] as const)(
    "uses the persisted %s conversation—not its sender—as the subject",
    (chatType) => {
      const { agentOptions } = fixture();
      const database = openOpenClawAgentDatabase(agentOptions);
      const conversationId = `conv_${chatType}`;
      const sessionKey = `agent:main:telegram:${chatType}:1`;
      const sessionId = `${chatType}-session`;
      database.db
        .prepare(
          `INSERT INTO conversations
         (conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at)
         VALUES (?, 'telegram', 'default', ?, ?, ?, 1, 1)`,
        )
        .run(conversationId, chatType, `${chatType}-1`, `${chatType}-1`);
      database.db
        .prepare(
          "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(sessionKey, sessionId, "{}", 1);
      database.db
        .prepare(
          `INSERT INTO session_windows
         (session_id, session_key, created_at, updated_at, chat_type, channel, account_id, primary_conversation_id)
         VALUES (?, ?, 1, 1, ?, 'telegram', 'default', ?)`,
        )
        .run(sessionId, sessionKey, chatType, conversationId);

      expect(
        admitInboundMemorySessionContext({
          context: { From: "telegram:attacker" },
          sessionKey,
          sessionId,
          options: agentOptions,
        }),
      ).toMatchObject({
        kind: "current",
        context: {
          subject: { kind: "conversation" },
          conversation: { deliveryTarget: `${chatType}-1` },
        },
      });
    },
  );

  it("turns expired identity evidence into immutable ambiguous provenance", () => {
    const { agentOptions, env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "expired-sender",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:expired",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      expiresAt: Date.now() - 1,
      options: { env },
    });

    expect(
      persistMemorySessionSubject({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        bindingId: binding.bindingId,
        options: agentOptions,
      }).subject,
    ).toEqual({ kind: "ambiguous" });
  });

  it("never issues a private subject for an incognito session", () => {
    const { env, profileId } = fixture();
    const agentOptions = {
      agentId: "main",
      env,
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
    };
    const database = openOpenClawAgentDatabase(agentOptions);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:incognito", "incognito-session", "{}", 1);
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "incognito-sender",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:incognito",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    expect(
      persistMemorySessionSubject({
        sessionKey: "agent:main:incognito",
        sessionId: "incognito-session",
        bindingId: binding.bindingId,
        options: agentOptions,
      }).subject,
    ).toEqual({ kind: "ambiguous" });
  });

  it("opens a current-version database before the additive subject tables are ensured", () => {
    const { agentOptions } = fixture();
    const original = openOpenClawAgentDatabase(agentOptions);
    original.db.exec(`
      DROP TRIGGER IF EXISTS session_memory_subject_snapshots_immutable;
      DROP TRIGGER IF EXISTS session_memory_subjects_immutable;
      DROP TABLE session_memory_subject_snapshots;
      DROP TABLE session_memory_subjects;
    `);
    closeOpenClawAgentDatabasesForTest();

    const reopened = openOpenClawAgentDatabase(agentOptions);
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_memory_subjects'",
        )
        .get(),
    ).toBeUndefined();

    persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      options: agentOptions,
    });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_memory_subjects'",
        )
        .get(),
    ).toEqual({ name: "session_memory_subjects" });
  });

  it("quarantines an imported session without provable subject lineage", async () => {
    const { agentOptions, env } = fixture();
    await importSqliteSessionRows({
      agentId: "main",
      env,
      sessionKey: "agent:main:imported",
      entry: { sessionId: "imported-session", updatedAt: 1 },
    });

    expect(
      openOpenClawAgentDatabase(agentOptions)
        .db.prepare("SELECT subject_kind FROM session_memory_subjects WHERE session_key = ?")
        .get("agent:main:imported"),
    ).toEqual({ subject_kind: "quarantined" });
  });

  it("preserves a confirmed logical subject across import and rechecks its binding", async () => {
    const { agentOptions, env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-import",
        adapterId: "plugin:telegram",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:import",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    const subject = persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      bindingId: binding.bindingId,
      options: agentOptions,
    });

    await importSqliteSessionRows({
      agentId: "main",
      env,
      sessionKey: "agent:main:direct:dm",
      entry: { sessionId: "imported-successor", updatedAt: 2 },
    });

    expect(
      openOpenClawAgentDatabase(agentOptions)
        .db.prepare(
          "SELECT subject_revision FROM session_memory_subject_snapshots WHERE session_id = ?",
        )
        .get("imported-successor"),
    ).toEqual({ subject_revision: subject.subjectRevision });
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "imported-successor",
        options: agentOptions,
      }),
    ).toMatchObject({ kind: "current", context: { bindingId: binding.bindingId } });
    expect(revokeMemoryIdentityBinding({ bindingId: binding.bindingId, options: { env } })).toBe(
      true,
    );
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "imported-successor",
        options: agentOptions,
      }),
    ).toEqual({ kind: "binding-revoked" });
  });

  it("keeps other direct channels ambiguous until their adapter opts into proof", () => {
    const { agentOptions, env, profileId } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "discord",
        accountId: "default",
        stableSenderId: "discord-user-1",
        adapterId: "plugin:discord",
        assurance: "adapter-attested",
        verificationMethod: "test",
        evidenceRevision: "test:discord",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    const database = openOpenClawAgentDatabase(agentOptions);
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("agent:main:discord:dm:1", "discord-session", "{}", Date.now());
    database.db
      .prepare(
        `INSERT INTO session_windows
         (session_id, session_key, session_scope, created_at, updated_at, chat_type, channel, account_id)
         VALUES (?, ?, 'conversation', ?, ?, 'direct', 'discord', 'default')`,
      )
      .run("discord-session", "agent:main:discord:dm:1", Date.now(), Date.now());

    expect(
      admitInboundMemorySessionContext({
        context: {},
        sessionKey: "agent:main:discord:dm:1",
        sessionId: "discord-session",
        options: agentOptions,
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(binding.bindingId).toBeTruthy();
  });

  it("mints only a loaded trusted adapter sender proof", () => {
    const admission = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    });
    const context = {};
    admission.attachVerifiedDirectSender({
      context,
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender",
    });
    const proof = consumeAdmittedChannelMemoryIdentityFromContext(context);
    expect(consumeAdmittedChannelMemoryIdentity(proof)).toMatchObject({
      channel: "telegram",
      adapterId: "plugin:telegram",
      assurance: "adapter-attested",
    });
  });

  it("does not mint for inactive or cross-channel adapters", () => {
    const inactive = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: () => true,
      isActive: () => false,
    });
    const crossChannel = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    });
    const allowed = {
      context: {},
      accountId: "default",
      stableSenderId: "sender",
    };
    expect(consumeAdmittedChannelMemoryIdentityFromContext(allowed.context)).toBeUndefined();
    inactive.attachVerifiedDirectSender({ channel: "telegram", ...allowed });
    crossChannel.attachVerifiedDirectSender({ channel: "discord", ...allowed });
    expect(consumeAdmittedChannelMemoryIdentityFromContext(allowed.context)).toBeUndefined();
  });

  it("requires an opaque admitted proof before an operator can link a sender", () => {
    const { env, profileId } = fixture();
    expect(() =>
      adminLinkAdmittedMemoryIdentity({
        admission: {} as never,
        authenticatedOperatorProfileId: profileId,
        authenticatedOperatorScopes: ["operator.admin"],
        options: { env },
      }),
    ).toThrow("admitted authenticated channel proof");
  });

  it("requires the authenticated Gateway admin scope before consuming admission", () => {
    const { env, profileId } = fixture();
    const admission = admitMemoryIdentity({
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-0",
      adapterId: "telegram-webhook",
      assurance: "authenticated",
      verificationMethod: "webhook-signature",
      evidenceRevision: "verified-envelope-0",
    });
    expect(() =>
      adminLinkAdmittedMemoryIdentity({
        admission,
        authenticatedOperatorProfileId: profileId,
        authenticatedOperatorScopes: [],
        options: { env },
      }),
    ).toThrow("operator.admin");
    expect(
      adminLinkAdmittedMemoryIdentity({
        admission,
        authenticatedOperatorProfileId: profileId,
        authenticatedOperatorScopes: ["operator.admin"],
        options: { env },
      }).principalId,
    ).toBeTruthy();
  });

  it("links only through an authenticated Gateway admin profile", () => {
    const { env, profileId } = fixture();
    const admission = () =>
      admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-gateway",
        adapterId: "telegram-webhook",
        assurance: "authenticated",
        verificationMethod: "webhook-signature",
        evidenceRevision: "verified-envelope-gateway",
      });
    expect(() =>
      linkAdmittedMemoryIdentityFromGateway({
        admission: admission(),
        client: { connect: { scopes: ["operator.admin"] } } as never,
        targetProfileId: profileId,
        options: { env },
      }),
    ).toThrow("authenticated Gateway profile");
    expect(() =>
      linkAdmittedMemoryIdentityFromGateway({
        admission: admission(),
        client: {
          connect: { scopes: [] },
          authenticatedUserProfile: { profileId },
        } as never,
        targetProfileId: profileId,
        options: { env },
      }),
    ).toThrow("operator.admin");
    expect(
      linkAdmittedMemoryIdentityFromGateway({
        admission: admission(),
        client: {
          connect: { scopes: ["operator.admin"] },
          authenticatedUserProfile: { profileId },
        } as never,
        targetProfileId: profileId,
        options: { env },
      }).principalId,
    ).toBeTruthy();
  });

  it("does not turn a raw resolver sender id into an identity capability", async () => {
    const ingress = await resolveStableChannelMessageIngress({
      channelId: "telegram",
      accountId: "default",
      subject: { stableId: "attacker-controlled" },
      conversation: { kind: "direct", id: "dm-1" },
      dmPolicy: "open",
      groupPolicy: "disabled",
    });
    // Whether the generic ingress policy allows this fixture is irrelevant:
    // its serializable result must never become identity-link authority.
    expect(ingress.ingress.decision).toMatch(/allow|block/);
    expect(consumeAdmittedChannelMemoryIdentity(ingress)).toBeUndefined();
  });

  it("keeps unbound/pairing-only ingress ambiguous", () => {
    const { agentOptions } = fixture();
    const subject = persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      options: agentOptions,
    });
    expect(subject.subject).toEqual({ kind: "ambiguous" });
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }),
    ).toEqual({ kind: "ambiguous" });
  });

  it.each([
    ["cron", "cron", false, "service"],
    ["heartbeat", "cron", false, "service"],
    ["subagent", "spawn", false, "agent"],
    ["system", "internal", false, "system"],
    ["import", undefined, false, "ambiguous"],
    ["non-direct channel", "channel", true, "ambiguous"],
    ["webhook without attestation", "channel", true, "ambiguous"],
    ["incognito channel without attestation", "channel", true, "ambiguous"],
  ] as const)(
    "persists the canonical %s subject without sender inference",
    (name, createdVia, deferredChannel, expectedKind) => {
      const { agentOptions } = fixture();
      const database = openOpenClawAgentDatabase(agentOptions);
      const sessionKey = `agent:main:memory-${name.replaceAll(" ", "-")}`;
      const sessionId = `session-${name.replaceAll(" ", "-")}`;
      runOpenClawAgentWriteTransaction(
        (transactionDatabase) => {
          writeSessionEntry(transactionDatabase, sessionKey, {
            sessionId,
            updatedAt: 1,
            ...(createdVia ? { createdVia } : {}),
          });
        },
        agentOptions,
        { operationLabel: "memory-session-subject.test.non-attested" },
      );
      if (deferredChannel) {
        expect(
          admitInboundMemorySessionContext({
            context: {},
            sessionKey,
            sessionId,
            options: agentOptions,
          }),
        ).toEqual({ kind: "ambiguous" });
      }
      const context = createCurrentMemorySessionContext({
        sessionKey,
        sessionId,
        options: agentOptions,
      });
      if (expectedKind === "ambiguous") {
        expect(context).toEqual({ kind: "ambiguous" });
      } else {
        expect(context).toMatchObject({
          kind: "current",
          context: { subject: { kind: expectedKind } },
        });
      }
      expect(
        database.db
          .prepare("SELECT subject_kind FROM session_memory_subjects WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ subject_kind: expectedKind });
    },
  );

  it("mints a frozen context only from core-captured facts after a current binding recheck", () => {
    const { env, profileId, agentOptions } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-context",
        adapterId: "telegram-webhook",
        assurance: "authenticated",
        verificationMethod: "webhook-signature",
        evidenceRevision: "verified-envelope-context",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      bindingId: binding.bindingId,
      options: agentOptions,
    });
    let externalFactsCurrent = true;
    const facts = captureTrustedMemoryAccessFacts({
      requestId: "request-1",
      runId: "run-1",
      actor: {
        kind: "principal",
        actorKind: "human",
        principalId: binding.principalId,
        assurance: "gateway-profile",
        evidenceRevision: binding.evidenceRevision,
      },
      verifiedPrincipals: [
        {
          principalId: binding.principalId,
          assurance: "gateway-profile",
          evidenceRevision: binding.evidenceRevision,
        },
      ],
      collaboration: { kind: "not-applicable" },
      verifiedMemberships: [],
      delivery: {
        sink: "private",
        audiences: [{ kind: "user", id: binding.principalId }],
        routeRevision: "route-1",
        egressCapabilityIds: ["reply.final"],
        egressRegistryRevision: "egress-1",
      },
      recheck: () => externalFactsCurrent,
      operation: "read",
      hostFactsRevision: "host-1",
    });
    const result = createTrustedMemoryAccessContext({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      options: agentOptions,
      facts,
    });
    expect(result.kind).toBe("current");
    if (result.kind !== "current") {
      return;
    }
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(isTrustedMemoryAccessContext(result.context)).toBe(true);
    expect(isTrustedMemoryAccessContext(JSON.parse(JSON.stringify(result.context)))).toBe(false);
    expect(
      materializeTrustedMemoryAccessContext({
        operation: "read",
        fingerprint: result.context.fingerprint,
      } as never),
    ).toBeUndefined();
    expect(readTrustedMemoryAccessSessionContext(result.context)).toMatchObject({
      bindingId: binding.bindingId,
    });
    expect(materializeTrustedMemoryAccessContext(result.context)).toMatchObject({
      sessionIdentityRevision: expect.any(String),
      subject: { kind: "user", principalId: binding.principalId },
      delivery: {
        audiences: [{ kind: "user", id: binding.principalId }],
        egressCapabilityIds: ["reply.final"],
      },
    });
    externalFactsCurrent = false;
    expect(materializeTrustedMemoryAccessContext(result.context)).toBeUndefined();
    externalFactsCurrent = true;
    const changedHostFacts = createTrustedMemoryAccessContext({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      options: agentOptions,
      facts: captureTrustedMemoryAccessFacts({
        requestId: "request-1",
        runId: "run-1",
        actor: {
          kind: "principal",
          actorKind: "human",
          principalId: binding.principalId,
          assurance: "gateway-profile",
          evidenceRevision: binding.evidenceRevision,
        },
        verifiedPrincipals: [
          {
            principalId: binding.principalId,
            assurance: "gateway-profile",
            evidenceRevision: binding.evidenceRevision,
          },
        ],
        collaboration: { kind: "not-applicable" },
        verifiedMemberships: [],
        delivery: {
          sink: "private",
          audiences: [{ kind: "user", id: binding.principalId }],
          routeRevision: "route-1",
          egressCapabilityIds: ["reply.final"],
          egressRegistryRevision: "egress-1",
        },
        operation: "read",
        hostFactsRevision: "host-2",
      }),
    });
    expect(changedHostFacts).toMatchObject({ kind: "current" });
    if (changedHostFacts.kind === "current") {
      expect(changedHostFacts.context.fingerprint).not.toBe(result.context.fingerprint);
    }
    expect(
      createTrustedMemoryAccessContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
        facts: { ...facts } as never,
      }),
    ).toEqual({ kind: "invalid-context" });
    expect(revokeMemoryIdentityBinding({ bindingId: binding.bindingId, options: { env } })).toBe(
      true,
    );
    // The context object is intentionally inert: its handoff must recheck
    // current authority so revocation between mint and use fails closed.
    expect(readTrustedMemoryAccessSessionContext(result.context)).toBeUndefined();
    expect(materializeTrustedMemoryAccessContext(result.context)).toBeUndefined();
    expect(
      createTrustedMemoryAccessContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
        facts,
      }),
    ).toEqual({ kind: "binding-revoked" });
  });

  it("rechecks a binding and fails closed after revocation", () => {
    const { env, profileId, agentOptions } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-1",
        adapterId: "telegram-webhook",
        assurance: "authenticated",
        verificationMethod: "webhook-signature",
        evidenceRevision: "verified-envelope-1",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      bindingId: binding.bindingId,
      options: agentOptions,
    });
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }).kind,
    ).toBe("current");
    expect(revokeMemoryIdentityBinding({ bindingId: binding.bindingId, options: { env } })).toBe(
      true,
    );
    expect(
      recheckMemoryIdentityBinding({ bindingId: binding.bindingId, options: { env } }),
    ).toEqual({
      kind: "revoked",
    });
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }),
    ).toEqual({ kind: "binding-revoked" });
  });

  it("rejects a changed current-session mapping before exposing a context", () => {
    const { agentOptions } = fixture();
    persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      options: agentOptions,
    });
    const database = openOpenClawAgentDatabase(agentOptions);
    database.db
      .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
      .run("session-2", "agent:main:direct:dm");
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-1",
        options: agentOptions,
      }),
    ).toEqual({ kind: "session-rebound" });
  });

  it("copies an immutable node subject into a reset successor snapshot", () => {
    const { env, profileId, agentOptions } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-reset",
        adapterId: "telegram-webhook",
        assurance: "authenticated",
        verificationMethod: "webhook-signature",
        evidenceRevision: "verified-envelope-reset",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    const subject = persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      bindingId: binding.bindingId,
      options: agentOptions,
    });
    const database = openOpenClawAgentDatabase(agentOptions);
    database.db
      .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
      .run("session-2", "agent:main:direct:dm");
    const snapshot = snapshotMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-2",
      options: agentOptions,
    });
    expect(snapshot?.subjectRevision).toBe(subject.subjectRevision);
    expect(
      createCurrentMemorySessionContext({
        sessionKey: "agent:main:direct:dm",
        sessionId: "session-2",
        options: agentOptions,
      }).kind,
    ).toBe("current");
  });

  it("copies subject provenance at the actual session-entry lifecycle owner", () => {
    const { env, profileId, agentOptions } = fixture();
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-lifecycle",
        adapterId: "telegram-webhook",
        assurance: "authenticated",
        verificationMethod: "webhook-signature",
        evidenceRevision: "verified-envelope-lifecycle",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    const database = openOpenClawAgentDatabase(agentOptions);
    // Let the canonical writer create its own valid session row. The generic
    // fixture seeds a deliberately minimal row only for direct subject tests.
    database.db
      .prepare("DELETE FROM session_nodes WHERE session_key = ?")
      .run("agent:main:direct:dm");
    const writeEntry = (sessionId: string, updatedAt: number, createdVia?: "channel") =>
      runOpenClawAgentWriteTransaction(
        (transactionDatabase) => {
          writeSessionEntry(transactionDatabase, "agent:main:direct:dm", {
            sessionId,
            updatedAt,
            ...(createdVia ? { createdVia } : {}),
          });
        },
        agentOptions,
        { operationLabel: "memory-session-subject.test.lifecycle" },
      );

    writeEntry("session-1", 1, "channel");
    const subject = persistMemorySessionSubject({
      sessionKey: "agent:main:direct:dm",
      sessionId: "session-1",
      bindingId: binding.bindingId,
      options: agentOptions,
    });
    for (const sessionId of [
      "session-reset",
      "session-rollover",
      "session-fork",
      "session-rewind",
      "session-recovery",
    ]) {
      writeEntry(sessionId, Date.now(), "channel");
      expect(
        createCurrentMemorySessionContext({
          sessionKey: "agent:main:direct:dm",
          sessionId,
          options: agentOptions,
        }),
      ).toMatchObject({
        kind: "current",
        context: { bindingId: binding.bindingId, principalId: binding.principalId },
      });
      expect(
        database.db
          .prepare(
            "SELECT subject_revision FROM session_memory_subject_snapshots WHERE session_id = ?",
          )
          .get(sessionId),
      ).toMatchObject({ subject_revision: subject.subjectRevision });
    }
  });

  it("denies a subject when its binding profile is no longer the merge head", () => {
    const { env, profileId } = fixture();
    const successor = ensureProfileForEmail("successor@example.com", { env });
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: admitMemoryIdentity({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-2",
        adapterId: "telegram-webhook",
        assurance: "authenticated",
        verificationMethod: "webhook-signature",
        evidenceRevision: "verified-envelope-2",
      }),
      authenticatedOperatorProfileId: profileId,
      authenticatedOperatorScopes: ["operator.admin"],
      options: { env },
    });
    linkEmail("operator@example.com", successor.id, { env });
    expect(
      recheckMemoryIdentityBinding({ bindingId: binding.bindingId, options: { env } }),
    ).toEqual({
      kind: "merge-head-mismatch",
    });
  });
});
