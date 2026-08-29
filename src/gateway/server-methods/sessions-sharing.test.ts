import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionMembersListEvidenceResultSchema,
  SessionSharingEvidenceEventSchema,
  SessionSharingEventSchema,
  type SessionMembersListEvidenceResult,
  type SessionSharingEvidenceEvent,
  type SessionSharingEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
} from "../../config/sessions/session-sharing-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, listProfiles, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attachGatewayLocalUserIngress,
  getGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../local-user-ingress.js";
import {
  authorizeResolvedSessionMutation,
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
  canReceiveSessionEvent,
  createSessionListEntryFilter,
  invalidateSessionSharingSnapshot,
} from "../session-sharing.js";
import { createControlUiHandlers } from "./control-ui.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import {
  identifiedClient,
  sessionSharingTestContext as context,
  soloClient,
} from "./sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type ResolveSessionSharingTarget =
  (typeof import("../session-sharing.js"))["resolveSessionSharingTarget"];

const targetResolutionMock = vi.hoisted(() => ({
  calls: 0,
  override: undefined as
    | undefined
    | ((
        target: ReturnType<ResolveSessionSharingTarget>,
        callIndex: number,
      ) => ReturnType<ResolveSessionSharingTarget>),
}));

vi.mock("../session-sharing.js", async () => {
  const actual =
    await vi.importActual<typeof import("../session-sharing.js")>("../session-sharing.js");
  return {
    ...actual,
    resolveSessionSharingTarget: (params: Parameters<ResolveSessionSharingTarget>[0]) => {
      const target = actual.resolveSessionSharingTarget(params);
      const callIndex = ++targetResolutionMock.calls;
      return targetResolutionMock.override?.(target, callIndex) ?? target;
    },
  };
});

afterEach(() => {
  targetResolutionMock.calls = 0;
  targetResolutionMock.override = undefined;
  closeOpenClawAgentDatabasesForTest();
});

async function call(
  method:
    | "session.visibility.set"
    | "session.members.list"
    | "session.members.listEvidence"
    | "session.members.add"
    | "session.members.remove",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  requestClient: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSharingHandlers[method]?.({
    params,
    client: requestClient,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

function sessionMembersListEvidenceResult(
  responses: Parameters<RespondFn>[],
): SessionMembersListEvidenceResult {
  const response = responses[0];
  if (response?.[0] !== true || response[1] === undefined) {
    throw new Error("expected one successful Gateway response");
  }
  return Value.Decode(SessionMembersListEvidenceResultSchema, response[1]);
}

function sharingEvents(broadcast: ReturnType<typeof vi.fn>): SessionSharingEvent[] {
  return broadcast.mock.calls.flatMap(([name, event]) =>
    name === "session.sharing" ? [Value.Decode(SessionSharingEventSchema, event)] : [],
  );
}

function sharingEvidenceEvents(broadcast: ReturnType<typeof vi.fn>): SessionSharingEvidenceEvent[] {
  return broadcast.mock.calls.flatMap(([name, event]) =>
    name === "session.sharing.evidence"
      ? [Value.Decode(SessionSharingEvidenceEventSchema, event)]
      : [],
  );
}

describe("session sharing handlers", () => {
  it("preserves profile actors and distinguishes unknown from absent profileless evidence", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const member = ensureProfileForEmail("sharing-evidence-member@example.com");
      const profiled = identifiedClient("profile-ada", "Ada");
      const unknown = soloClient();
      attachGatewayLocalUserIngress(
        unknown,
        prepareGatewayLocalUserIngress({
          authMethod: "trusted-proxy",
          authenticatedUserExpected: true,
          isLocalClient: false,
        }),
      );
      const absent = soloClient();
      const cases = [
        { name: "present", client: profiled },
        { name: "unknown", client: unknown },
        { name: "absent", client: absent },
      ] as const;
      const listings = new Map<string, SessionMembersListEvidenceResult>();

      for (const item of cases) {
        const sessionKey = `agent:main:sharing-actor-${item.name}`;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `session-sharing-actor-${item.name}`,
            updatedAt: 1,
            visibility: "shared",
            ...(item.name === "present"
              ? { createdActor: { type: "human" as const, id: "profile-ada" } }
              : {}),
          },
        );
        const broadcast = vi.fn();
        const requestContext = context(broadcast);
        requestContext.getSessionEventSubscriberConnIds = () => new Set(["legacy-client"]);
        expect(
          await call(
            "session.visibility.set",
            { sessionKey, visibility: "draft" },
            requestContext,
            item.client,
          ),
        ).toMatchObject([[true, { ok: true, sessionKey }, undefined]]);
        expect(
          await call(
            "session.members.add",
            { sessionKey, identityId: member.id },
            requestContext,
            item.client,
          ),
        ).toEqual([[true, { ok: true, sessionKey, identityId: member.id }, undefined]]);
        const listed = await call(
          "session.members.listEvidence",
          { sessionKey },
          requestContext,
          item.client,
        );
        listings.set(item.name, sessionMembersListEvidenceResult(listed));
        const legacyListed = await call(
          "session.members.list",
          { sessionKey },
          requestContext,
          item.client,
        );
        expect(legacyListed[0]?.[0]).toBe(item.name === "present");
        if (item.name === "present") {
          expect(legacyListed[0]?.[1]).toMatchObject({
            members: [{ identityId: member.id, addedBy: "profile-ada" }],
          });
        } else {
          expect(legacyListed[0]?.[2]?.details).toEqual({
            code: "SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED",
            recommendedMethod: "session.members.listEvidence",
          });
        }
        expect(
          await call(
            "session.members.remove",
            { sessionKey, identityId: member.id },
            requestContext,
            item.client,
          ),
        ).toEqual([[true, { ok: true, sessionKey, identityId: member.id }, undefined]]);
        flushPendingSessionsChangedEvents(requestContext);
        expect(requestContext.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "sharing", sessionKey }),
          new Set(["legacy-client"]),
          expect.objectContaining({ sessionKeys: [sessionKey] }),
        );
        const publishedEvents = sharingEvents(broadcast);
        expect(publishedEvents.map((event) => event.action)).toEqual(
          item.name === "present" ? ["visibility", "member-added", "member-removed"] : [],
        );
        const publishedEvidenceEvents = sharingEvidenceEvents(broadcast);
        expect(publishedEvidenceEvents.map((event) => event.action)).toEqual(
          item.name === "present" ? [] : ["visibility", "member-added", "member-removed"],
        );
        for (const event of publishedEvents) {
          expect(event.actor).toMatchObject({ type: "human", id: "profile-ada", label: "Ada" });
        }
        for (const event of publishedEvidenceEvents) {
          expect(event).not.toHaveProperty("actor");
          if (item.name === "unknown") {
            expect(event).toMatchObject({ actorState: "unknown" });
          } else {
            expect(event).not.toHaveProperty("actorState");
          }
        }
        expect(JSON.stringify([publishedEvidenceEvents, listings.get(item.name)])).not.toMatch(
          /local-operator|operator\.admin|actor-evidence:/,
        );
      }
      const listedMember = (name: "present" | "unknown" | "absent") =>
        listings.get(name)?.members[0];
      expect(listings.get("present")).toMatchObject({
        members: [{ identityId: member.id, addedBy: "profile-ada" }],
      });
      expect(listings.get("unknown")).toMatchObject({
        members: [{ identityId: member.id, addedByState: "unknown" }],
      });
      expect(listedMember("unknown")).not.toHaveProperty("addedBy");
      expect(listings.get("absent")).toMatchObject({
        members: [{ identityId: member.id }],
      });
      expect(listedMember("absent")).not.toHaveProperty("addedBy");
      expect(listedMember("absent")).not.toHaveProperty("addedByState");
      expect(getGatewayLocalUserIngress(unknown)?.facts.invoker).toEqual({ state: "unknown" });
      expect(getGatewayLocalUserIngress(absent)).toBeUndefined();
    });
  });

  it("keeps real actor-evidence profile ids while discarding beta synthetic actors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:sharing-storage-projection";
      const sessionId = "session-sharing-storage-projection";
      await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      for (const [identityId, addedBy, addedAt] of [
        ["legacy-admin-member", "operator.admin", 1],
        ["legacy-local-member", "local-operator", 2],
        ["real-prefix-member", "actor-evidence:profile-ada", 3],
      ] as const) {
        expect(
          addSessionMember(
            { agentId: "main", sessionKey },
            { identityId, addedBy, addedAt, expectedSessionId: sessionId },
          ).inserted,
        ).toBe(true);
      }

      const response = await call("session.members.listEvidence", { sessionKey }, context(vi.fn()));
      const result = sessionMembersListEvidenceResult(response);
      const member = (identityId: string) =>
        result.members.find((candidate) => candidate.identityId === identityId);
      expect(member("real-prefix-member")).toMatchObject({
        addedBy: "actor-evidence:profile-ada",
      });
      for (const identityId of ["legacy-admin-member", "legacy-local-member"]) {
        expect(member(identityId)).not.toHaveProperty("addedBy");
        expect(member(identityId)).not.toHaveProperty("addedByState");
      }
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("actor-evidence:unknown");
      expect(serialized).not.toContain("actor-evidence:unattributed");
      expect(serialized).not.toContain("operator.admin");
      expect(serialized).not.toContain("local-operator");
    });
  });

  it("admits bare fixed-store keys only through their persisted owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.path("shared-sessions.sqlite");
      await upsertSessionEntryCore(
        { agentId: "ops", sessionKey: "global", storePath },
        { sessionId: "session-ops-global", updatedAt: 1, visibility: "shared" },
      );
      const ownedConfig = {
        session: { scope: "global", store: storePath },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;

      expect(
        await call("session.members.list", { sessionKey: "global" }, context(vi.fn(), ownedConfig)),
      ).toMatchObject([[true, { sessionKey: "global", role: "owner" }, undefined]]);

      const ownerlessConfig = {
        ...ownedConfig,
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } as ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      const rejected = await call(
        "session.members.list",
        { sessionKey: "global" },
        context(vi.fn(), ownerlessConfig),
      );
      expect(rejected[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("has no explicit owner"),
      });
    });
  });

  it("keeps hidden incognito rows from changing non-owner list path metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const incognitoKey = "agent:main:dashboard:incognito-private";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:main" },
        { sessionId: "session-main", updatedAt: 1 },
      );
      const viewer = identifiedClient("viewer@example.com");
      const admin = soloClient();
      admin.connect.scopes = ["operator.admin"];
      const listFor = async (client: GatewayClient) => {
        const responses: Parameters<RespondFn>[] = [];
        await sessionReadHandlers["sessions.list"]?.({
          params: {},
          client,
          context: {
            ...context(vi.fn()),
            loadGatewayModelCatalog: async () => [],
          } as unknown as GatewayRequestContext,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never);
        return responses[0]?.[1] as
          | { path?: string; sessions?: Array<{ key: string }> }
          | undefined;
      };

      const before = await listFor(viewer);
      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey: incognitoKey,
          storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        },
        {
          sessionId: "session-incognito",
          updatedAt: 2,
          incognito: true,
          visibility: "shared",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );

      const hidden = await listFor(viewer);
      expect(hidden?.path).toBe(before?.path);
      expect(hidden?.sessions?.some((session) => session.key === incognitoKey)).toBe(false);
      const creator = await listFor(identifiedClient("owner@example.com"));
      expect(creator?.path).toBe(before?.path);
      expect(creator?.sessions?.some((session) => session.key === incognitoKey)).toBe(false);
      const visible = await listFor(admin);
      expect(visible?.sessions?.some((session) => session.key === incognitoKey)).toBe(true);
      expect(visible?.path).not.toBe(before?.path);
    });
  });

  it("never previews sessions hidden from sessions.list", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:dashboard:incognito-preview";
      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey,
          storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        },
        {
          sessionId: "session-incognito-preview",
          updatedAt: 2,
          incognito: true,
          visibility: "shared",
          createdActor: { type: "human", id: "owner@example.com" },
        },
      );
      const previewFor = async (client: GatewayClient) => {
        const responses: Parameters<RespondFn>[] = [];
        await createControlUiHandlers()["controlUi.sessionPreview"]?.({
          params: { sessionKey },
          client,
          context: context(vi.fn()),
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never);
        return responses[0]?.[1];
      };

      expect(await previewFor(identifiedClient("viewer@example.com"))).toEqual({
        status: "unavailable",
      });
      const admin = soloClient();
      admin.connect.scopes = ["operator.admin"];
      expect(await previewFor(admin)).toMatchObject({
        status: "ok",
        sessionKey,
        agentId: "main",
      });
    });
  });

  it("rejects a visibility mutation when the queued session instance changed", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:stale-sharing-mutation";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-authorized",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      targetResolutionMock.override = (target, callIndex) =>
        callIndex === 2 && target
          ? {
              ...target,
              entry: { ...target.entry, sessionId: "session-replaced" },
            }
          : target;
      const broadcast = vi.fn();
      const respond = vi.fn();

      await expect(
        sessionSharingHandlers["session.visibility.set"]?.({
          params: { sessionKey, visibility: "draft" },
          client: soloClient(),
          context: context(broadcast),
          respond,
        } as never),
      ).rejects.toThrow("session changed before sharing mutation");

      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("shared");
      expect(respond).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalledWith(
        "session.sharing",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("authorizes runs against the resolved session so keyless runs cannot bypass restriction", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:main";
      const owner = { id: "owner@example.com", label: "Owner" };
      const outsider = identifiedClient("outsider");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-main",
          updatedAt: 1,
          createdActor: { type: "human", ...owner },
          visibility: "read-only",
        },
      );

      // The agent-run handler authorizes this resolved (default/effective) key
      // even when the request omitted sessionKey; a non-participant is blocked.
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: outsider,
          sessionKey,
          agentId: "main",
        }),
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      // The owner, and a not-yet-created session, both pass.
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: identifiedClient(owner.id, owner.label),
          sessionKey,
          agentId: "main",
        }),
      ).toBeNull();
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: outsider,
          sessionKey: "agent:main:fresh",
          agentId: "main",
        }),
      ).toBeNull();
    });
  });

  it("projects a shared session member's truthful role in sessions.list", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:shared-member";
      const memberIdentity = { id: "member@example.com", label: "Member" };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-shared-member",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: memberIdentity.id, addedBy: "owner@example.com", addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const responses: Parameters<RespondFn>[] = [];
      await sessionReadHandlers["sessions.list"]?.({
        params: { agentId: "main" },
        client: identifiedClient(memberIdentity.id, memberIdentity.label),
        context: {
          ...context(vi.fn()),
          loadGatewayModelCatalog: async () => [],
        } as unknown as GatewayRequestContext,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);

      expect(responses[0]?.[0]).toBe(true);
      const payload = responses[0]?.[1] as
        | { sessions?: Array<{ key: string; sharingRole?: string }> }
        | undefined;
      expect(payload?.sessions?.find((session) => session.key === sessionKey)?.sharingRole).toBe(
        "member",
      );
    });
  });

  it("drops a session flipped to draft during the list await from a non-owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:mid-await-draft";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-mid-await",
          updatedAt: 1,
          createdActor: { type: "human", id: "owner@example.com" },
          visibility: "shared",
        },
      );
      // A member of the (soon-draft) session must also lose it: drafts are
      // owner+admin only.
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: "member@example.com", addedBy: "owner@example.com", addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const outsider = identifiedClient("outsider@example.com");
      // The awaited model-catalog step flips the session to draft after the
      // pre-await draft filter ran, exercising the final fresh-target filter.
      const listWith = async (client: GatewayClient) => {
        await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
          visibility: "shared",
        }));
        invalidateSessionSharingSnapshot(sessionKey);
        const responses: Parameters<RespondFn>[] = [];
        await sessionReadHandlers["sessions.list"]?.({
          params: { agentId: "main" },
          client,
          context: {
            ...context(vi.fn()),
            readPreparedGatewayModelCatalog: async () => {
              await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
                visibility: "draft",
              }));
              invalidateSessionSharingSnapshot(sessionKey);
              return { entries: [] };
            },
          } as unknown as GatewayRequestContext,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never);
        return responses[0]?.[1] as
          | {
              count: number;
              totalCount: number;
              nextOffset: number | null;
              hasMore: boolean;
              owners: Array<{ type: "human" | "agent"; id: string }>;
              sessions: Array<{ key: string }>;
            }
          | undefined;
      };

      // Non-owner must not receive the now-draft row (no preview/metadata leak).
      const outsiderList = await listWith(outsider);
      expect(outsiderList?.sessions.some((session) => session.key === sessionKey)).toBe(false);
      expect(outsiderList).toMatchObject({
        count: 0,
        totalCount: 0,
        nextOffset: null,
        hasMore: false,
        owners: [],
      });
      // A member also loses a draft (owner+admin only).
      expect(
        (await listWith(identifiedClient("member@example.com")))?.sessions.some(
          (session) => session.key === sessionKey,
        ),
      ).toBe(false);
      // The owner still sees their own draft.
      expect(
        (await listWith(identifiedClient("owner@example.com")))?.sessions.some(
          (session) => session.key === sessionKey,
        ),
      ).toBe(true);
    });
  });

  it("refills a paged session list after its first row becomes a draft", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const hiddenKey = "agent:main:mid-await-paged-draft";
      const visibleKey = "agent:main:mid-await-paged-visible";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: hiddenKey },
        {
          sessionId: "session-mid-await-paged-draft",
          updatedAt: 2,
          createdActor: { type: "human", id: "hidden-owner@example.com" },
          visibility: "shared",
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: visibleKey },
        {
          sessionId: "session-mid-await-paged-visible",
          updatedAt: 1,
          createdActor: { type: "human", id: "visible-owner@example.com" },
          visibility: "shared",
        },
      );
      const responses: Parameters<RespondFn>[] = [];

      await sessionReadHandlers["sessions.list"]?.({
        params: { agentId: "main", limit: 1 },
        client: identifiedClient("outsider@example.com"),
        context: {
          ...context(vi.fn()),
          readPreparedGatewayModelCatalog: async () => {
            await patchSessionEntryCore({ agentId: "main", sessionKey: hiddenKey }, () => ({
              visibility: "draft",
            }));
            invalidateSessionSharingSnapshot(hiddenKey);
            return { entries: [] };
          },
        } as unknown as GatewayRequestContext,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);

      expect(responses[0]?.[0]).toBe(true);
      expect(responses[0]?.[1]).toMatchObject({
        count: 1,
        totalCount: 1,
        limitApplied: 1,
        nextOffset: null,
        hasMore: false,
        owners: [],
        sessions: [{ key: visibleKey }],
      });
    });
  });

  it("lists profile ids and authorizes a selected profile as a member", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:profile-member";
      const profile = ensureProfileForEmail("member@example.com");
      setDisplayName(profile.id, "Member");
      const selectable = listProfiles().find((item) => item.id === profile.id);
      expect(selectable).toMatchObject({ id: profile.id, displayName: "Member" });
      if (!selectable) {
        throw new Error("expected member profile in picker identities");
      }
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-profile-member",
          updatedAt: 1,
          visibility: "read-only",
        },
      );
      const requestContext = context(vi.fn());

      const listed = await call("session.members.list", { sessionKey }, requestContext);
      expect(listed[0]?.[1]).toMatchObject({
        identities: expect.arrayContaining([
          expect.objectContaining({ type: "human", id: profile.id, label: "Member" }),
        ]),
      });
      expect(
        await call(
          "session.members.add",
          { sessionKey, identityId: selectable.id },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, identityId: profile.id }, undefined]]);
      expect(
        authorizeResolvedSessionMutation({
          cfg: {},
          client: identifiedClient(profile.id, "Member"),
          sessionKey,
          agentId: "main",
        }),
      ).toBeNull();
    });
  });

  it("revokes all member access while a session is draft and restores it when shared", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:member-transition";
      const owner = { id: "owner@example.com", label: "Owner" };
      const memberIdentity = { id: "member@example.com", label: "Member" };
      const memberClient = identifiedClient(memberIdentity.id, memberIdentity.label);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-member-transition",
          updatedAt: 1,
          createdActor: { type: "human", ...owner },
          visibility: "shared",
        },
      );
      expect(
        addSessionMember(
          { agentId: "main", sessionKey },
          { identityId: memberIdentity.id, addedBy: owner.id, addedAt: 1 },
        ).inserted,
      ).toBe(true);
      const requestContext = {
        ...context(vi.fn()),
        execApprovalManager: {
          lookupApprovalId: () => ({ kind: "exact", id: "approval-1" }),
          getSnapshot: () => ({ request: { sessionKey, agentId: "main" } }),
        },
      } as unknown as GatewayRequestContext;
      const mutations: Array<[string, Record<string, unknown>]> = [
        ["chat.send", { sessionKey }],
        ["sessions.steer", { key: sessionKey }],
        ["sessions.abort", { key: sessionKey }],
        ["sessions.dispatch", { key: sessionKey, profileId: "shared" }],
        [
          "sessions.move",
          {
            key: sessionKey,
            expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
            target: { kind: "gateway" },
          },
        ],
        ["sessions.reclaim", { key: sessionKey }],
        ["exec.approval.resolve", { id: "approval-1" }],
      ];
      const expectAccess = (allowed: boolean) => {
        for (const [method, requestParams] of mutations) {
          const error = resolveSessionMutationAuthorization({
            client: memberClient,
            method,
            requestParams,
            context: requestContext,
          }).error;
          if (allowed) {
            expect(error, method).toBeNull();
          } else {
            expect(error, method).toMatchObject({
              details: { code: "SESSION_PARTICIPATION_REQUIRED" },
            });
          }
        }
        const entry = loadSessionEntry({ agentId: "main", sessionKey });
        if (!entry) {
          throw new Error("expected member transition session entry");
        }
        const listed = createSessionListEntryFilter({ client: memberClient })?.(sessionKey, entry);
        expect(listed ?? true).toBe(allowed);
        expect(
          canReceiveSessionEvent({
            cfg: {},
            client: memberClient as never,
            sessionKeys: [sessionKey],
            agentId: "main",
          }),
        ).toBe(allowed);
      };

      expectAccess(true);
      const captured = resolveSessionMutationAuthorization({
        client: memberClient,
        method: "sessions.dispatch",
        requestParams: { key: sessionKey, profileId: "shared" },
        context: requestContext,
      });
      expect(captured.error).toBeNull();
      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({ visibility: "draft" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expectAccess(false);
      expect(() => captured.authorization?.assertCurrent()).toThrow(
        SessionMutationAuthorizationChangedError,
      );
      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
        visibility: "shared",
      }));
      invalidateSessionSharingSnapshot(sessionKey);
      expectAccess(true);
    });
  });

  it("publishes canonical visibility and membership changes without changing the transcript", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "session-main", updatedAt: 1 },
      );
      const broadcast = vi.fn();
      const requestContext = context(broadcast);
      const member = ensureProfileForEmail("member-change@example.com");
      const transcriptBefore = await loadTranscriptEvents({
        agentId: "main",
        sessionId: "session-main",
        sessionKey,
      });

      expect(
        await call(
          "session.visibility.set",
          { sessionKey, visibility: "read-only" },
          requestContext,
        ),
      ).toEqual([[true, { ok: true, sessionKey, visibility: "read-only" }, undefined]]);
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.visibility).toBe("read-only");

      expect(
        await call("session.members.add", { sessionKey, identityId: member.id }, requestContext),
      ).toEqual([[true, { ok: true, sessionKey, identityId: member.id }, undefined]]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([
        expect.objectContaining({
          identityId: member.id,
          addedBy: "actor-evidence:unattributed",
        }),
      ]);

      expect(
        await call("session.members.remove", { sessionKey, identityId: member.id }, requestContext),
      ).toEqual([[true, { ok: true, sessionKey, identityId: member.id }, undefined]]);
      expect(listSessionMembers({ agentId: "main", sessionKey })).toEqual([]);

      expect(
        await loadTranscriptEvents({
          agentId: "main",
          sessionId: "session-main",
          sessionKey,
        }),
      ).toEqual(transcriptBefore);
      const publishedEvents = broadcast.mock.calls
        .filter(([event]) => event === "session.sharing.evidence")
        .map(([, payload, options]) => ({ payload, options }));
      expect(publishedEvents).toEqual([
        {
          payload: expect.objectContaining({
            action: "visibility",
            sessionKey,
            visibility: "read-only",
          }),
          options: { sessionKeys: [sessionKey] },
        },
        {
          payload: expect.objectContaining({
            action: "member-added",
            sessionKey,
            identityId: member.id,
          }),
          options: { sessionKeys: [sessionKey] },
        },
        {
          payload: expect.objectContaining({
            action: "member-removed",
            sessionKey,
            identityId: member.id,
          }),
          options: { sessionKeys: [sessionKey] },
        },
      ]);

      const restrictedKey = "agent:main:restricted";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: restrictedKey },
        {
          sessionId: "session-restricted",
          updatedAt: 2,
          visibility: "read-only",
          category: "Projects",
        },
      );
      expect(
        resolveSessionMutationAuthorization({
          client: identifiedClient("viewer"),
          method: "sessions.groups.delete",
          requestParams: { name: "Projects" },
          context: requestContext,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });
      expect(
        await call("session.members.list", { sessionKey: restrictedKey }, requestContext, {
          ...identifiedClient("viewer"),
        }),
      ).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({ code: "SESSION_SHARING_MANAGER_REQUIRED" }),
          }),
        ],
      ]);

      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
        visibility: "shared",
      }));
      invalidateSessionSharingSnapshot();
      const viewerClient = identifiedClient("viewer") as never;
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(true);
      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({ visibility: "draft" }));
      invalidateSessionSharingSnapshot(sessionKey);
      expect(
        canReceiveSessionEvent({
          cfg: {},
          client: viewerClient,
          sessionKeys: ["main"],
          agentId: "main",
        }),
      ).toBe(false);
    });
  });
});
