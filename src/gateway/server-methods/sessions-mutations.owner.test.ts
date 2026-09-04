import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerInternalHook, unregisterInternalHook } from "../../hooks/internal-hooks.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchGatewayMethodInProcess } from "../server-plugins.js";
import { isSessionPermissionChangePending } from "../session-permission-change.js";
import {
  createSessionListEntryFilter,
  resolveSessionMutationAuthorization,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => {
  flushPendingSessionsChangedEvents();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

function client(profileId?: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.write"],
    },
    ...(profileId
      ? {
          authenticatedUserId: `${profileId}@example.com`,
          authenticatedUserProfile: {
            profileId,
            displayName: profileId,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function context(cfg: OpenClawConfig) {
  return {
    trackExecution: trackAsyncWork,
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(["observer"]),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

async function invoke(params: {
  cfg: OpenClawConfig;
  client: GatewayClient;
  request: Record<string, unknown>;
}) {
  const requestContext = context(params.cfg);
  const authorization = resolveSessionMutationAuthorization({
    client: params.client,
    method: "sessions.assignOwner",
    requestParams: params.request,
    context: requestContext,
  });
  const responses: Parameters<RespondFn>[] = [];
  if (!authorization.error) {
    await sessionMutationHandlers["sessions.assignOwner"]?.({
      params: params.request,
      client: params.client,
      context: requestContext,
      sessionMutationAuthorization: authorization.authorization,
      respond: (...response: Parameters<RespondFn>) => responses.push(response),
    } as never);
  }
  return { authorization, requestContext, responses };
}

describe("sessions.patch", () => {
  it("publishes saved settings when applying permissions to the active run fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:failed-permission-update";
      const sessionId = "failed-permission-update";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId, updatedAt: 1, permissionMode: "guarded" },
      );
      const abort = vi.fn();
      const handle = {
        ...createEmbeddedRunHandle({ abort }),
        applyPermissionMode: async () => {
          throw new Error("Runtime update failed");
        },
      };
      const patched = vi.fn(async () => {});
      registerInternalHook("session:patch", patched);
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      const respond = vi.fn();
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: sessionKey, permissionMode: "read-only", label: "Updated session" },
          client: client(),
          context: context({}),
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining("Permissions were saved") }),
        );
        expect(abort).toHaveBeenCalledOnce();
        expect(loadSessionEntry({ agentId: "main", env: state.env, sessionKey })).toMatchObject({
          permissionMode: "read-only",
          label: "Updated session",
        });
        expect(patched).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKey,
            context: expect.objectContaining({
              sessionEntry: expect.objectContaining({ permissionMode: "read-only" }),
            }),
          }),
        );
        expect(isSessionPermissionChangePending(sessionId)).toBe(false);
      } finally {
        unregisterInternalHook("session:patch", patched);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });

  it("serializes permission changes through live-runtime acknowledgement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:permission-update";
      const sessionId = "session-permission-update";
      const cfg: OpenClawConfig = {};
      const requestContext = context(cfg);
      const requestClient = client();
      requestClient.connect.scopes = ["operator.admin"];
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId, updatedAt: 1, permissionMode: "guarded" },
      );
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const applyPermissionMode = vi.fn(async (_mode: string | null, revoke: () => void) => {
        revoke();
        entered.resolve();
        await release.promise;
        return true;
      });
      const handle = { ...createEmbeddedRunHandle(), applyPermissionMode };
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      const responses = [vi.fn(), vi.fn()];
      const patch = (permissionMode: "full" | "read-only", index: number) =>
        sessionMutationHandlers["sessions.patch"]!({
          params: { key: sessionKey, permissionMode },
          client: requestClient,
          context: requestContext,
          respond: responses[index]!,
        } as never);
      const first = patch("full", 0);
      let second: ReturnType<typeof patch> | undefined;
      try {
        await Promise.race([entered.promise, first]);
        expect(applyPermissionMode).toHaveBeenCalledTimes(1);
        expect(responses[0]).not.toHaveBeenCalled();
        expect(isSessionPermissionChangePending(sessionId)).toBe(true);
        expect(
          loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
        ).toBe("full");
        second = patch("read-only", 1);
        await Promise.resolve();
        expect(applyPermissionMode).toHaveBeenCalledTimes(1);
        release.resolve();
        await Promise.all([first, second]);
        expect(applyPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(["full", "read-only"]);
        expect(responses[0]).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(responses[1]).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(isSessionPermissionChangePending(sessionId)).toBe(false);
        expect(
          loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
        ).toBe("read-only");
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });

  it("refuses unsupported live permission changes before saving a misleading mode", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:unsupported-permissions";
      const sessionId = "unsupported-permissions";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId, updatedAt: 1, permissionMode: "guarded" },
      );
      const handle = createEmbeddedRunHandle();
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      const respond = vi.fn();
      try {
        await sessionMutationHandlers["sessions.patch"]!({
          params: { key: sessionKey, permissionMode: "read-only" },
          client: client(),
          context: context({}),
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.stringContaining("Stop the run") }),
        );
        expect(
          loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.permissionMode,
        ).toBe("guarded");
        expect(isSessionPermissionChangePending(sessionId)).toBe(false);
      } finally {
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      }
    });
  });

  it("keeps a newly created session visible to its identified non-admin creator", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profileId = ensureProfileForEmail("patch-creator@example.test").id;
      const sessionKey = "agent:main:patch-created";
      const requestClient = client(profileId);
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "member",
            definitions: {
              member: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.write"],
              },
            },
          },
        },
      };
      const requestContext = context(cfg);
      const patch = async (pinned: boolean) => {
        const request = { key: sessionKey, pinned };
        const authorization = resolveSessionMutationAuthorization({
          client: requestClient,
          method: "sessions.patch",
          requestParams: request,
          context: requestContext,
        });
        expect(authorization.error).toBeNull();
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.patch"]?.({
          params: request,
          client: requestClient,
          context: requestContext,
          sessionMutationAuthorization: authorization.authorization,
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      };

      await patch(true);
      const entry = loadSessionEntry({ agentId: "main", env: state.env, sessionKey });
      expect(entry).toMatchObject({
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: profileId },
        createdAt: expect.any(Number),
      });
      if (!entry) {
        throw new Error("expected patch-created session entry");
      }
      expect(
        createSessionListEntryFilter({ client: requestClient, cfg })?.(sessionKey, entry),
      ).toBe(true);

      await patch(false);
      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.pinnedAt,
      ).toBeUndefined();
    });
  });
});

describe("sessions.assignOwner", () => {
  it("records the trusted in-process agent tool caller as the assigning agent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:handoff";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-handoff",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "research", identity: { name: "Research" } },
          ],
        },
      } as OpenClawConfig;
      const requestContext = context(cfg);
      await expect(
        dispatchGatewayMethodInProcess(
          "sessions.assignOwner",
          { key: sessionKey, owner: { type: "agent", id: "research" } },
          {
            forceSyntheticClient: true,
            agentToolCaller: {
              agentId: "main",
              sessionKey: "agent:main:discord:direct:colin",
            },
            syntheticScopes: ["operator.write"],
            resolveGatewayContext: () => requestContext,
          },
        ),
      ).resolves.toMatchObject({
        ok: true,
        key: sessionKey,
        owner: {
          actor: { type: "agent", id: "research", label: "Research" },
          assignedBy: { type: "agent", id: "main" },
        },
      });

      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner,
      ).toMatchObject({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "agent", id: "main" },
      });
    });
  });

  it("lets a write-scoped viewer assign a shared session without changing sharing authority", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:handoff";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-handoff",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      const cfg = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "research", identity: { name: "Research" } },
          ],
        },
      } as OpenClawConfig;
      vi.spyOn(Date, "now").mockReturnValue(4242);

      const result = await invoke({
        cfg,
        client: client("profile-viewer"),
        request: { key: sessionKey, owner: { type: "agent", id: "research" } },
      });

      expect(result.authorization.error).toBeNull();
      expect(result.responses).toMatchObject([
        [
          true,
          {
            ok: true,
            key: sessionKey,
            owner: {
              actor: { type: "agent", id: "research", label: "Research" },
              assignedBy: { type: "human", id: "profile-viewer" },
              assignedAt: 4242,
            },
          },
          undefined,
        ],
      ]);
      expect(loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-viewer" },
        assignedAt: 4242,
      });
      const durableOwner = ensureProfileForEmail("next-owner@example.test");
      const reassigned = await invoke({
        cfg,
        client: client("profile-viewer"),
        request: {
          key: sessionKey,
          owner: { type: "human", id: durableOwner.id },
        },
      });
      expect(reassigned.responses).toMatchObject([
        [
          true,
          {
            owner: {
              actor: { type: "human", id: durableOwner.id },
              assignedBy: { type: "human", id: "profile-viewer" },
            },
          },
          undefined,
        ],
      ]);
      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner?.actor,
      ).toEqual({ type: "human", id: durableOwner.id });

      const target = resolveSessionSharingTarget({ cfg, sessionKey, agentId: "main" });
      if (!target) {
        throw new Error("expected assigned session target");
      }
      expect(resolveSessionSharingRole({ client: client("profile-creator"), target })).toBe(
        "owner",
      );
      expect(resolveSessionSharingRole({ client: client("research"), target })).toBe("viewer");
    });
  });

  it("rejects hidden viewers, unidentified callers, and unknown owner targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:private-handoff";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-private-handoff",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      const cfg = {
        agents: { list: [{ id: "main", default: true }, { id: "research" }] },
      } as OpenClawConfig;
      const request = { key: sessionKey, owner: { type: "agent", id: "research" } };
      const hidden = await invoke({ cfg, client: client("profile-viewer"), request });
      expect(hidden.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: "session is not visible to this connection",
      });

      const unidentified = await invoke({
        cfg,
        client: client(),
        request: {
          key: sessionKey,
          owner: { type: "human", id: "profile-next" },
        },
      });
      expect(unidentified.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: "sessions.assignOwner requires an identified caller",
      });

      const nonSyntheticInternal = await invoke({
        cfg,
        client: {
          ...client(),
          internal: {
            agentToolCaller: {
              agentId: "main",
              sessionKey: "agent:main:discord:direct:colin",
            },
          },
        },
        request,
      });
      expect(nonSyntheticInternal.responses[0]?.[2]).toMatchObject({
        code: "FORBIDDEN",
        message: "sessions.assignOwner requires an identified caller",
      });

      const smuggled = await invoke({
        cfg,
        client: client(),
        request: {
          key: sessionKey,
          owner: { type: "human", id: "profile-next" },
          agentToolCaller: {
            agentId: "main",
            sessionKey: "agent:main:discord:direct:colin",
          },
        },
      });
      expect(smuggled.responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("unexpected property 'agentToolCaller'"),
      });

      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-private-handoff",
          updatedAt: 2,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: "profile-creator" },
        },
      );
      for (const owner of [
        { type: "human" as const, id: "unknown-profile" },
        { type: "human" as const, id: "discord:channel:123" },
        { type: "agent" as const, id: "missing" },
      ]) {
        const unknown = await invoke({
          cfg,
          client: client("profile-viewer"),
          request: { key: sessionKey, owner },
        });
        expect(unknown.responses[0]?.[2]).toMatchObject({
          code: "INVALID_REQUEST",
          message: `unknown session owner "${owner.id}"`,
        });
      }
      expect(
        loadSessionEntry({ agentId: "main", env: state.env, sessionKey })?.owner,
      ).toBeUndefined();
    });
  });
});
