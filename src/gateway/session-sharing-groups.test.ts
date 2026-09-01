import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionGroupHandlers } from "./server-methods/sessions-groups.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  listSessionGroupDefaults,
  listSessionGroups,
  putSessionGroups,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import {
  sharingPolicyClient as client,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("session sharing group mutations", () => {
  it("refuses restricted group drops at put admission while allowing retained groups", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups({ cfg: {}, names: ["Projects"] });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-put-member" },
        {
          sessionId: "session-restricted-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = roleClient("none", "put-viewer");
      const context = { getRuntimeConfig: () => rolePolicyConfig() } as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { names: [] },
          context,
        }).error,
      ).not.toBeNull();
      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { names: [" Projects "] },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("rechecks late group members before committing a put drop", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const groups = putSessionGroups({ cfg: {}, names: ["Race"] });
      const viewer = roleClient("none", "put-viewer");
      const context = {
        getRuntimeConfig: () => rolePolicyConfig(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.put",
        requestParams: { names: [] },
        context,
      });
      expect(authorization).toMatchObject({ error: null, authorization: expect.any(Object) });

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-put-member" },
        {
          sessionId: "session-late-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.put"]?.({
          params: { names: [] },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroups()).toEqual(groups);
    });
  });

  it("rechecks group members before committing a defaults update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups({ cfg: {}, names: ["Race"] });
      updateSessionGroupDefaults("Race", { cwd: "/repos/race", worktree: true });
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: " Race ", cwd: null, worktree: false },
        context,
      });
      expect(authorization.error).toBeNull();

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-restricted-member" },
        {
          sessionId: "session-late-restricted-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.update"]?.({
          params: { name: " Race ", cwd: null, worktree: false },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroupDefaults()).toEqual([
        { name: "Race", cwd: "/repos/race", worktree: true },
      ]);
    });
  });

  it("filters group defaults and blocks updates for sessions the caller cannot mutate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      putSessionGroups({ cfg: {}, names: ["Projects", "Personal"] });
      updateSessionGroupDefaults("Projects", { cwd: "/repos/projects", worktree: true });
      updateSessionGroupDefaults("Personal", { cwd: "/repos/personal", worktree: false });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-project" },
        {
          sessionId: "session-restricted-project",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.update",
          requestParams: { name: "Projects", cwd: null, worktree: false },
          context,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const responses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.defaults"]?.({
        params: {},
        client: viewer,
        context,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
      expect(responses).toEqual([
        [
          true,
          { defaults: [{ name: "Personal", cwd: "/repos/personal", worktree: false }] },
          undefined,
        ],
      ]);

      const personalAuthorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { name: "Personal", cwd: null, worktree: false },
        context,
      });
      expect(personalAuthorization.error).toBeNull();
      const updateResponses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.update"]?.({
        params: { name: "Personal", cwd: null, worktree: false },
        client: viewer,
        context,
        sessionMutationAuthorization: personalAuthorization.authorization,
        respond: (...response: Parameters<RespondFn>) => updateResponses.push(response),
      } as never);
      expect(updateResponses).toEqual([
        [true, { ok: true, defaults: [{ name: "Personal", worktree: false }] }, undefined],
      ]);
    });
  });
});
