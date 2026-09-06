import { afterEach, expect, test, vi } from "vitest";
import {
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { loadGatewayModelCatalog as loadActualGatewayModelCatalog } from "../server-model-catalog.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  closeOpenClawAgentDatabasesForTest();
});

function patchContext(
  loadGatewayModelCatalog: GatewayRequestContext["loadGatewayModelCatalog"],
  cfg: OpenClawConfig = {},
) {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalog,
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function patchRequest(context: GatewayRequestContext) {
  return (params: Record<string, unknown>, respond: ReturnType<typeof vi.fn>) =>
    sessionMutationHandlers["sessions.patch"]!({
      params,
      respond,
      context,
      client: null,
    } as never);
}

test("catalog reload releases the agent writer while preserving same-session ordering", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const catalogKey = "agent:main:catalog-dependent";
    const metadataKey = "agent:main:independent-metadata";
    for (const sessionKey of [catalogKey, metadataKey]) {
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId: sessionKey, updatedAt: 1 },
      );
    }
    const entered = createDeferredCore();
    const replacement = markPreparedModelRuntimeSnapshotsStale("catalog reload", {
      waitForReplacement: true,
    });
    expect(replacement).toBeDefined();
    const loadGatewayModelCatalog = vi.fn(async () => {
      entered.resolve();
      return await loadActualGatewayModelCatalog({ agentId: "main", getConfig: () => ({}) });
    });
    const context = patchContext(loadGatewayModelCatalog);
    const catalogResponse = vi.fn();
    const metadataResponse = vi.fn();
    const successorResponse = vi.fn();
    const patch = patchRequest(context);
    const catalogPatch = patch({ key: catalogKey, contextWindow: "extended" }, catalogResponse);
    let metadataPatch: ReturnType<typeof patch> | undefined;
    let successorPatch: ReturnType<typeof patch> | undefined;
    let blockedMetadata: Error | undefined;
    try {
      await Promise.race([entered.promise, catalogPatch]);
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(catalogResponse).not.toHaveBeenCalled();
      successorPatch = patch({ key: catalogKey, pinned: true }, successorResponse);
      metadataPatch = patch({ key: metadataKey, pinned: true }, metadataResponse);
      await vi
        .waitFor(() =>
          expect(metadataResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined),
        )
        .catch((error: unknown) => {
          blockedMetadata = error instanceof Error ? error : new Error(String(error));
        });
      expect(catalogResponse).not.toHaveBeenCalled();
      expect(successorResponse).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.pinnedAt,
      ).toBeUndefined();
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    } finally {
      rejectPendingPreparedModelRuntimeReplacement(
        replacement,
        new Error("Synthetic catalog reload failed"),
      );
      await Promise.allSettled([catalogPatch, metadataPatch, successorPatch]);
    }
    expect(catalogResponse).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Session patch failed unexpectedly. Retry the request.",
      retryable: true,
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.contextWindow,
    ).toBeUndefined();
    expect(metadataResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(successorResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.pinnedAt).toEqual(
      expect.any(Number),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: metadataKey })?.pinnedAt).toEqual(
      expect.any(Number),
    );
    if (blockedMetadata) {
      throw blockedMetadata;
    }
  });
});

test.each(["identity", "label", "alias", "cleared-selection"] as const)(
  "catalog preparation revalidates fresh %s before using the prepared result",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = change === "alias" ? "agent:main:main" : "agent:main:catalog-revalidation";
      const storedKey = change === "alias" ? "agent:main:work" : key;
      const otherKey = "agent:main:new-label-owner";
      const existing: SessionEntry = {
        sessionId: "before",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        ...(change === "cleared-selection"
          ? { thinkingLevel: "high", contextWindow: "extended" }
          : {}),
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey: storedKey }, existing);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: otherKey },
        { sessionId: "other", updatedAt: 1 },
      );
      const entered = createDeferredCore();
      const catalog =
        createDeferredCore<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
      const loadGatewayModelCatalog = vi.fn(() => {
        entered.resolve();
        return catalog.promise;
      });
      const patch = patchRequest(
        patchContext(
          loadGatewayModelCatalog,
          change === "alias"
            ? {
                session: { mainKey: "work" },
                agents: { list: [{ id: "main", default: true }] },
              }
            : {},
        ),
      );
      const response = vi.fn();
      const pending = patch(
        change === "cleared-selection"
          ? { key, model: null }
          : {
              key,
              expectedSessionId: "before",
              contextWindow: "extended",
              ...(change === "label" ? { label: "Claimed" } : {}),
            },
        response,
      );
      let mutation: Promise<unknown> | void = undefined;
      const changed = vi.fn();
      try {
        await Promise.race([entered.promise, pending]);
        expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
        expect(response).not.toHaveBeenCalled();
        mutation =
          change === "label"
            ? patch({ key: otherKey, label: "Claimed" }, changed)
            : upsertSessionEntryCore(
                { agentId: "main", sessionKey: key },
                change === "identity" || change === "alias"
                  ? { sessionId: "replacement", updatedAt: 2, label: "Replacement" }
                  : {
                      ...existing,
                      updatedAt: 2,
                      thinkingLevel: undefined,
                      contextWindow: undefined,
                    },
              ).then(() => changed());
        await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      } finally {
        if (change === "alias") {
          catalog.resolve([]);
        } else {
          catalog.reject(new Error("Synthetic catalog preparation failed"));
        }
        await Promise.allSettled([pending, mutation]);
      }
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      const stored = loadSessionEntry({ agentId: "main", sessionKey: storedKey });
      if (change === "cleared-selection") {
        expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(stored).toMatchObject({ sessionId: "before" });
        expect(stored?.modelOverride).toBeUndefined();
        expect(stored?.providerOverride).toBeUndefined();
        expect(stored?.thinkingLevel).toBeUndefined();
        expect(stored?.contextWindow).toBeUndefined();
      } else if (change === "identity") {
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: { reason: "session-changed" },
          }),
        );
        expect(stored).toMatchObject({ sessionId: "replacement", label: "Replacement" });
        expect(stored?.contextWindow).toBeUndefined();
      } else if (change === "alias") {
        expect(response).toHaveBeenCalledWith(false, undefined, {
          code: "UNAVAILABLE",
          message: "Session patch failed unexpectedly. Retry the request.",
          retryable: true,
        });
        expect(stored).toMatchObject({ sessionId: "before" });
        expect(stored?.contextWindow).toBeUndefined();
        expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
          sessionId: "replacement",
          label: "Replacement",
        });
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: key })?.contextWindow,
        ).toBeUndefined();
      } else {
        expect(changed).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(response).toHaveBeenCalledWith(false, undefined, {
          code: "INVALID_REQUEST",
          message: "label already in use: Claimed",
        });
        expect(stored?.label).toBeUndefined();
        expect(stored?.contextWindow).toBeUndefined();
        expect(loadSessionEntry({ agentId: "main", sessionKey: otherKey })?.label).toBe("Claimed");
      }
    });
  },
);

test("patchMany prepares singleton agent groups without blocking another session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const targets = ["main", "secondary"].map((agentId) => ({
      key: `agent:${agentId}:catalog-batch`,
    }));
    for (const [index, { key }] of targets.entries()) {
      await upsertSessionEntryCore(
        { agentId: index === 0 ? "main" : "secondary", sessionKey: key },
        { sessionId: key, updatedAt: 1 },
      );
    }
    const metadataKey = "agent:main:batch-independent";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: metadataKey },
      { sessionId: metadataKey, updatedAt: 1 },
    );
    const catalog =
      createDeferredCore<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const context = patchContext(loadGatewayModelCatalog, {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [{ id: "main" }, { id: "secondary" }],
      },
    });
    const respond = vi.fn();
    const batch = sessionMutationHandlers["sessions.patchMany"]!({
      params: { targets, patch: { contextWindow: "extended" } },
      respond,
      context,
      client: null,
    } as never);
    const metadataResponse = vi.fn();
    let metadataPatch: Promise<void> | void = undefined;
    try {
      await vi.waitFor(() => expect(loadGatewayModelCatalog).toHaveBeenCalledTimes(2));
      metadataPatch = patchRequest(context)({ key: metadataKey, pinned: true }, metadataResponse);
      await vi.waitFor(() =>
        expect(metadataResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined),
      );
      expect(respond).not.toHaveBeenCalled();
    } finally {
      catalog.resolve([
        {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Sonnet",
          contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
        },
      ]);
      await Promise.allSettled([batch, metadataPatch]);
    }
    expect(loadGatewayModelCatalog).toHaveBeenCalledTimes(2);
    expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "main" });
    expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "secondary" });
    expect(respond).toHaveBeenCalledWith(
      true,
      { outcomes: targets.map(({ key }) => ({ key, ok: true })) },
      undefined,
    );
    for (const [index, { key }] of targets.entries()) {
      expect(
        loadSessionEntry({ agentId: index === 0 ? "main" : "secondary", sessionKey: key })
          ?.contextWindow,
      ).toBe("extended");
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: metadataKey })?.pinnedAt).toEqual(
      expect.any(Number),
    );
  });
});

test("a multi-target agent group retains ordered label claims around catalog loading", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const targets = ["first", "second"].map((name) => ({ key: `agent:main:ordered-${name}` }));
    for (const { key } of targets) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { sessionId: key, updatedAt: 1 },
      );
    }
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const respond = vi.fn();
    await sessionMutationHandlers["sessions.patchMany"]!({
      params: { targets, patch: { label: "Winner", thinkingLevel: "off" } },
      respond,
      context: patchContext(loadGatewayModelCatalog),
      client: null,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        outcomes: [
          { key: targets[0]!.key, ok: true },
          {
            key: targets[1]!.key,
            ok: false,
            error: { code: "INVALID_REQUEST", message: "label already in use: Winner" },
          },
        ],
      },
      undefined,
    );
    expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ agentId: "main", sessionKey: targets[0]!.key })).toMatchObject({
      label: "Winner",
      thinkingLevel: "off",
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: targets[1]!.key })?.label,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: targets[1]!.key })?.thinkingLevel,
    ).toBeUndefined();
  });
});

test("dispatched authorization rejects an instance replaced during catalog preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:commit-bound-authorization";
    // A write-scoped model reset revalidates retained thinking. Admin scope would
    // bypass the session-instance authorization this request must exercise.
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-shared", updatedAt: 1, visibility: "shared", thinkingLevel: "off" },
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const respond = vi.fn();
    const request = handleGatewayRequest({
      req: {
        type: "req",
        id: "catalog-authorization",
        method: "sessions.patch",
        params: { key: sessionKey, label: "stale mutation", model: null },
      },
      respond,
      client: {
        connId: "catalog-authorization",
        authenticatedUserId: "member@example.com",
        authenticatedUserProfile: {
          profileId: "member",
          displayName: "Member",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          role: "operator",
          scopes: ["operator.write"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        ...patchContext(async () => {
          entered.resolve();
          await release.promise;
          return [];
        }),
        logGateway: { warn: vi.fn() },
        broadcast: vi.fn(),
      } as unknown as GatewayRequestContext,
      extraHandlers: { "sessions.patch": sessionMutationHandlers["sessions.patch"]! },
    });
    let replacement: Promise<void> | undefined;
    const committed = vi.fn();
    try {
      await Promise.race([entered.promise, request]);
      expect(respond).not.toHaveBeenCalled();
      replacement = (async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-draft-replacement",
            updatedAt: 2,
            thinkingLevel: undefined,
            visibility: "draft",
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: "owner" },
          },
        );
        await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
          visibility: "draft",
        }));
        committed();
      })();
      void replacement.catch(() => {});
      await vi.waitFor(() => expect(committed).toHaveBeenCalledOnce());
      await replacement;
      release.resolve();
      await request;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
        }),
      );
      const current = loadSessionEntry({ agentId: "main", sessionKey });
      expect(current).toMatchObject({
        sessionId: "session-draft-replacement",
        visibility: "draft",
      });
      expect(current).not.toHaveProperty("label");
      expect(current).not.toHaveProperty("thinkingLevel");
    } finally {
      release.resolve();
      await Promise.allSettled([request, replacement]);
    }
  });
});
