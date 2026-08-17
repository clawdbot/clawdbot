import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { dispatchGatewayMethodInProcess, setFallbackGatewayContext } from "../server-plugins.js";
import {
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
          createdActor: { type: "human", id: "profile-creator" },
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
      const clearContext = setFallbackGatewayContext(requestContext);

      try {
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
      } finally {
        clearContext();
      }

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
          createdActor: { type: "human", id: "profile-creator" },
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
      expect(result.requestContext.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          reason: "owner",
          owner: expect.objectContaining({ actor: expect.objectContaining({ id: "research" }) }),
        }),
        expect.any(Set),
        expect.any(Object),
      );

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

  it("rejects hidden viewers, unidentified callers, and unknown agent targets", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:private-handoff";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "session-private-handoff",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", id: "profile-creator" },
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
          createdActor: { type: "human", id: "profile-creator" },
        },
      );
      const unknown = await invoke({
        cfg,
        client: client("profile-viewer"),
        request: { key: sessionKey, owner: { type: "agent", id: "missing" } },
      });
      expect(unknown.responses[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: 'unknown agent id "missing"',
      });
    });
  });
});
