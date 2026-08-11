import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryContentAccessContext } from "openclaw/plugin-sdk/memory-authorization";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorizedMemoryReadHost } from "../../../../src/agents/memory-authorized-read-host.js";
import {
  consumeAdmittedChannelMemoryIdentityFromContext,
  createChannelMemoryIdentityAdmission,
} from "../../../../src/channels/message-access/memory-identity-admission.js";
import { resetMemoryIsolationCutoverForTest } from "../../../../src/plugins/memory-cutover.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.js";
import {
  adminLinkAdmittedMemoryIdentity,
  ensureMemoryOperationalPrincipal,
} from "../../../../src/state/memory-identity.js";
import { admitInboundMemorySessionContext } from "../../../../src/state/memory-session-subject.js";
import { openOpenClawAgentDatabase } from "../../../../src/state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../../../src/state/user-profiles.js";
import { MEMORY_CORE_AUTHORIZATION_CAPABILITIES } from "../authorization.js";
import { builtinScopedMemoryConformanceAdapter } from "./scoped-memory-policy.js";
import { createBuiltinScopedMemoryResource } from "./scoped-memory-resources.js";
import {
  builtinScopedMemoryAuthorizedRuntime,
  resetBuiltinScopedMemoryAuthorizedRuntimeForTest,
} from "./scoped-memory-runtime.js";
import { createBuiltinScopedMemoryStore } from "./scoped-memory-store.js";

describe("builtin scoped authorized runtime", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-memory-runtime-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    resetBuiltinScopedMemoryAuthorizedRuntimeForTest();
    resetMemoryIsolationCutoverForTest();
    resetPluginRuntimeStateForTest();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function markCutOver() {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES ('scoped-runtime-cutover', 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
      )
      .run();
    resetMemoryIsolationCutoverForTest();
  }

  function installBuiltinSelectedRuntime() {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "memory-core", memorySlotSelected: true } as never);
    registry.memoryCapabilities.push({
      pluginId: "memory-core",
      capability: {
        authorization: MEMORY_CORE_AUTHORIZATION_CAPABILITIES,
        authorizationConformance: builtinScopedMemoryConformanceAdapter,
        runtime: builtinScopedMemoryAuthorizedRuntime,
      },
    });
    setActivePluginRegistry(registry);
  }

  function createSession(params: {
    sessionKey: string;
    sessionId: string;
    chatType: "direct" | "group" | "channel";
    primaryConversationId?: string;
  }) {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
      )
      .run(params.sessionKey, params.sessionId, '{"toolsBySender":{"alice":{"role":"owner"}}}');
    if (params.primaryConversationId) {
      database.db
        .prepare(
          `INSERT INTO conversations
           (conversation_id, channel, account_id, kind, peer_id, delivery_target, created_at, updated_at)
           VALUES (?, 'telegram', 'default', ?, ?, ?, 1, 1)`,
        )
        .run(
          params.primaryConversationId,
          params.chatType,
          `${params.chatType}-peer`,
          `${params.chatType}-target`,
        );
    }
    database.db
      .prepare(
        `INSERT INTO session_windows
         (session_id, session_key, created_at, updated_at, chat_type, channel, account_id, primary_conversation_id)
         VALUES (?, ?, 1, 1, ?, 'telegram', 'default', ?)`,
      )
      .run(
        params.sessionId,
        params.sessionKey,
        params.chatType,
        params.primaryConversationId ?? null,
      );
  }

  function createVerifiedDirectSession(params: {
    name: "alice" | "bob";
    sessionKey: string;
    sessionId: string;
  }) {
    createSession({ ...params, chatType: "direct" });
    const profile = ensureProfileForEmail(`${params.name}@example.test`);
    const admission = createChannelMemoryIdentityAdmission({
      pluginId: "telegram",
      adapterId: "plugin:telegram",
      ownsChannel: (channel) => channel === "telegram",
      isActive: () => true,
    });
    const linkingContext = {};
    admission.attachVerifiedDirectSender({
      context: linkingContext,
      channel: "telegram",
      accountId: "default",
      stableSenderId: params.name,
    });
    const proof = consumeAdmittedChannelMemoryIdentityFromContext(linkingContext);
    if (!proof) {
      throw new Error("fixture failed to mint a verified identity admission");
    }
    const binding = adminLinkAdmittedMemoryIdentity({
      admission: proof,
      authenticatedOperatorProfileId: profile.id,
      targetProfileId: profile.id,
      authenticatedOperatorScopes: ["operator.admin"],
    });
    const inboundContext = {};
    admission.attachVerifiedDirectSender({
      context: inboundContext,
      channel: "telegram",
      accountId: "default",
      stableSenderId: params.name,
    });
    const admitted = admitInboundMemorySessionContext({
      context: inboundContext,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      options: { agentId: "main" },
    });
    if (admitted.kind !== "current") {
      throw new Error("fixture failed to persist a verified direct subject");
    }
    return binding.principalId;
  }

  function createConversationSession(params: {
    sessionKey: string;
    sessionId: string;
    conversationId: string;
  }) {
    createSession({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      chatType: "group",
      primaryConversationId: params.conversationId,
    });
    const admitted = admitInboundMemorySessionContext({
      context: {
        From: "telegram:alice",
        senderRole: "owner",
        toolsBySender: { alice: { role: "owner" } },
      },
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      options: { agentId: "main" },
    });
    if (admitted.kind !== "current" || admitted.context.subject.kind !== "conversation") {
      throw new Error("fixture failed to persist a conversation subject");
    }
    return admitted.context.principalId;
  }

  function createContext(principalId: string): MemoryContentAccessContext<"read"> {
    return {
      version: 1,
      contextId: `context-${principalId}`,
      contextFingerprint: `fingerprint-${principalId}`,
      requestId: "request-1",
      runId: "run-1",
      agentId: "main",
      sessionKey: `agent:main:direct:${principalId}`,
      sessionId: `session-${principalId}`,
      sessionIdentityRevision: "session-revision-1",
      subjectRevision: "subject-revision-1",
      subject: {
        version: 1,
        kind: "user",
        principalId,
        creationEvidence: { kind: "gateway-profile", revision: `binding-${principalId}` },
      },
      actor: {
        kind: "principal",
        actorKind: "human",
        principalId,
        assurance: "gateway-profile",
        evidenceRevision: `binding-${principalId}`,
      },
      verifiedPrincipals: [
        {
          principalId,
          assurance: "gateway-profile",
          evidenceRevision: `binding-${principalId}`,
        },
      ],
      delivery: {
        sinkKind: "private",
        audiences: [{ kind: "user", id: principalId }],
        egressCapabilityIds: ["reply.final"],
        egressRegistryRevision: "egress-1",
        deliveryRevision: `delivery-${principalId}`,
      },
      collaboration: { kind: "not-applicable" },
      verifiedMemberships: [],
      operation: "read",
      hostFactsRevision: "host-1",
    };
  }

  function createPrivateResource(principalId: string, content: string) {
    const store = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: principalId,
      authorityKind: "user",
      authorityOwnerId: principalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "human", id: principalId },
      reason: "private placement",
    });
    return createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "MEMORY.md",
      content,
      actor: { kind: "human", id: principalId },
    });
  }

  it("postfilters before result count and issues plan-bound exact-read handles", async () => {
    const alice = createPrivateResource("alice", "shared signal from alice");
    createPrivateResource("bob", "shared signal from bob");
    const context = createContext("alice");
    const plan = await builtinScopedMemoryAuthorizedRuntime.authorize(context);
    const result = await builtinScopedMemoryAuthorizedRuntime.searchAuthorized({
      context,
      plan,
      query: "shared signal",
      limit: 10,
    });

    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({ snippet: "shared signal from alice" });
    expect(result.exposureReceipt.exposedRevisionHandles).toEqual([alice.revisionId]);
    const hit = result.value[0];
    if (!hit) {
      return;
    }
    await expect(
      builtinScopedMemoryAuthorizedRuntime.readAuthorized({
        context,
        plan,
        handle: hit.resourceHandle,
      }),
    ).resolves.toMatchObject({ value: { text: "shared signal from alice" } });
    await expect(
      builtinScopedMemoryAuthorizedRuntime.readAuthorized({
        context,
        plan,
        handle: { ...hit.resourceHandle, resourceRevision: "forged" },
      }),
    ).rejects.toThrow("unavailable");
  });

  it("keeps verified private stores isolated through the actual host and selected runtime", async () => {
    const aliceSession = { sessionKey: "agent:main:direct:alice", sessionId: "alice-session" };
    const bobSession = { sessionKey: "agent:main:direct:bob", sessionId: "bob-session" };
    const alicePrincipalId = createVerifiedDirectSession({ name: "alice", ...aliceSession });
    const bobPrincipalId = createVerifiedDirectSession({ name: "bob", ...bobSession });
    createPrivateResource(alicePrincipalId, "ALICE_PRIVATE_TITLE\nneedle only from Alice");
    for (let index = 0; index < 20; index += 1) {
      createPrivateResource(
        bobPrincipalId,
        `BOB_PRIVATE_TITLE_${index}\n${"needle ".repeat(index + 20)}BOB_SNIPPET_SCORE_COUNT_CITATION_CURSOR_${index}`,
      );
    }
    markCutOver();
    installBuiltinSelectedRuntime();

    const aliceHost = createAuthorizedMemoryReadHost({ agentId: "main", ...aliceSession });
    const bobHost = createAuthorizedMemoryReadHost({ agentId: "main", ...bobSession });
    if (!aliceHost || !bobHost) {
      throw new Error("fixture failed to build an authorized memory host");
    }

    const aliceResults = await aliceHost.search({ query: "needle", limit: 1 });
    expect(aliceResults).toMatchObject({
      results: [{ path: "memory/MEMORY.md", snippet: "ALICE_PRIVATE_TITLE" }],
    });
    const alicePayload = JSON.stringify(aliceResults);
    expect(alicePayload).not.toContain("BOB_PRIVATE_TITLE");
    expect(alicePayload).not.toContain("BOB_SNIPPET_SCORE_COUNT_CITATION_CURSOR");

    const bobResults = await bobHost.search({ query: "needle", limit: 1 });
    if (!("results" in bobResults) || !bobResults.results[0]) {
      throw new Error("fixture failed to return Bob's own scoped handle");
    }
    await expect(aliceHost.read({ handleId: bobResults.results[0].handleId })).resolves.toEqual({
      disabled: true,
      unavailable: true,
      error: "memory unavailable",
    });
    await expect(aliceHost.read({ handleId: "mhandle1_forged" })).resolves.toEqual({
      disabled: true,
      unavailable: true,
      error: "memory unavailable",
    });
  });

  it("mounts only channel and explicitly addressed copies for a group actor", async () => {
    const session = { sessionKey: "agent:main:telegram:group:1", sessionId: "group-session" };
    const conversationPrincipalId = createConversationSession({
      ...session,
      conversationId: "telegram-group-1",
    });
    const channelStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: conversationPrincipalId,
      authorityKind: "conversation",
      authorityOwnerId: conversationPrincipalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "unattributed" },
      reason: "channel placement",
    });
    const projectionStore = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "conversation",
      audienceKind: "conversation",
      audienceId: conversationPrincipalId,
      authorityKind: "conversation",
      authorityOwnerId: conversationPrincipalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "unattributed" },
      reason: "explicitly addressed projection placement",
    });
    const alicePrincipal = ensureMemoryOperationalPrincipal({
      kind: "service",
      stableRef: "alice-role-shaped-sender",
      options: { agentId: "main" },
    });
    const alicePrivate = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "user",
      audienceKind: "user",
      audienceId: alicePrincipal.principalId,
      authorityKind: "user",
      authorityOwnerId: alicePrincipal.principalId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "human", id: alicePrincipal.principalId },
      reason: "private placement",
    });
    const ownerRole = createBuiltinScopedMemoryStore({
      agentId: "main",
      scopeKind: "role",
      audienceKind: "role",
      audienceId: "owners",
      authorityKind: "role",
      authorityOwnerId: "owners",
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "system" },
      reason: "role placement",
    });
    for (const [store, logicalLocator, content, actor] of [
      [channelStore, "channel.md", "GROUP_CHANNEL_ONLY", { kind: "unattributed" }],
      [
        projectionStore,
        "projection.md",
        "GROUP_EXPLICITLY_ADDRESSED_PROJECTION",
        { kind: "unattributed" },
      ],
      [
        alicePrivate,
        "alice-private.md",
        "GROUP_DENIED_ALICE_PRIVATE_PATH_TITLE_SNIPPET_SCORE_COUNT_CITATION_CURSOR",
        { kind: "human", id: alicePrincipal.principalId },
      ],
      [ownerRole, "owner-role.md", "GROUP_DENIED_OWNER_ROLE_FROM_LATEST_ACTOR", { kind: "system" }],
    ] as const) {
      createBuiltinScopedMemoryResource({
        agentId: "main",
        store,
        logicalLocator,
        content,
        actor,
      });
    }
    markCutOver();
    installBuiltinSelectedRuntime();

    const host = createAuthorizedMemoryReadHost({ agentId: "main", ...session });
    if (!host) {
      throw new Error("fixture failed to build a group memory host");
    }
    const result = await host.search({ query: "GROUP", limit: 10 });
    expect(result).toMatchObject({
      results: [
        { snippet: "GROUP_CHANNEL_ONLY" },
        { snippet: "GROUP_EXPLICITLY_ADDRESSED_PROJECTION" },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(
      "GROUP_DENIED_ALICE_PRIVATE_PATH_TITLE_SNIPPET_SCORE_COUNT_CITATION_CURSOR",
    );
    expect(serialized).not.toContain("GROUP_DENIED_OWNER_ROLE_FROM_LATEST_ACTOR");
  });
});
