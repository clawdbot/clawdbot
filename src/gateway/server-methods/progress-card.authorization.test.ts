import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { progressCardStore } from "../progress-card-store.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  resolveSessionMutationAuthorization,
  resolveSessionSharingTarget,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createLazyCoreHandlers } from "./lazy-core-handlers.js";
import { createProgressCardHandlers } from "./progress-card.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

describe("progress card request authorization", () => {
  it.each(
    (["global", "agent:work:progress-authorization"] as const).flatMap((sessionKey) =>
      (["progressCard.get", "progressCard.put"] as const).flatMap((method) =>
        [false, true].map((replace) => ({ sessionKey, method, replace })),
      ),
    ),
  )(
    "revalidates $method for $sessionKey after preparation (replace=$replace)",
    async (testCase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { scope: "per-sender" },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const target = { sessionKey: testCase.sessionKey, agentId: "work" };
        const client = { ...roleClient("view", "admitted-owner"), connId: "admitted-owner" };
        const successor = roleClient("view", "successor-owner");
        const ownerId = client.authenticatedUserProfile!.profileId;
        const successorId = successor.authenticatedUserProfile!.profileId;
        await upsertSessionEntryCore(target, {
          sessionId: "admitted-generation",
          updatedAt: 1,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: ownerId },
        });
        progressCardStore.put(target.sessionKey, { markdown: "original card" }, target.agentId);
        const broadcast = vi.fn();
        const context = {
          getRuntimeConfig: () => cfg,
          broadcast,
          logGateway: { warn: vi.fn() },
          resolveGatewayContext: (): GatewayRequestContext => context,
        } as unknown as GatewayRequestContext;
        const params = {
          ...target,
          ...(testCase.method === "progressCard.put" ? { markdown: "request update" } : {}),
        };
        const oracle = resolveSessionMutationAuthorization({
          client,
          method: testCase.method,
          requestParams: params,
          context,
        });
        expect(oracle.error).toBeNull();
        const authorization = oracle.authorization;
        if (!authorization) {
          throw new Error("expected a captured session authorization");
        }
        authorization.assertCurrent();
        const loaded = createDeferredCore();
        const release = createDeferredCore();
        const handlers = createProgressCardHandlers();
        const loadHandlers = vi.fn(async () => {
          loaded.resolve();
          await release.promise;
          return handlers;
        });
        const extraHandlers = createLazyCoreHandlers({ methods: [testCase.method], loadHandlers });
        const dispatch = (respond: RespondFn) =>
          handleGatewayRequest({
            req: { type: "req", id: "progress-authorization", method: testCase.method, params },
            client,
            context,
            isWebchatConnect: () => false,
            respond,
            extraHandlers,
          });
        const respond = vi.fn<RespondFn>();
        const pending = dispatch(respond);
        try {
          await Promise.race([
            loaded.promise,
            pending.then(() => {
              throw new Error("request completed before lazy preparation");
            }),
          ]);
          expect(respond).not.toHaveBeenCalled();
          if (testCase.replace) {
            const resolved = resolveSessionSharingTarget({ cfg, ...target });
            if (!resolved) {
              throw new Error("expected the admitted persisted session");
            }
            await expect(
              deleteSessionEntryLifecycle({
                agentId: resolved.agentId,
                archiveTranscript: false,
                expectedSessionId: "admitted-generation",
                storePath: resolved.storePath,
                target: { canonicalKey: resolved.canonicalKey, storeKeys: resolved.storeKeys },
              }),
            ).resolves.toMatchObject({ deleted: true });
            await upsertSessionEntryCore(target, {
              sessionId: "successor-generation",
              updatedAt: 2,
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: successorId },
            });
            progressCardStore.put(
              target.sessionKey,
              { markdown: "successor card" },
              target.agentId,
            );
            expect(loadSessionEntry(target)).toMatchObject({
              sessionId: "successor-generation",
              visibility: "draft",
              createdActor: { id: successorId },
            });
            expect(() => authorization.assertCurrent()).toThrow(
              SessionMutationAuthorizationChangedError,
            );
            const fresh = vi.fn<RespondFn>();
            await dispatch(fresh);
            expect(fresh).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                details: expect.objectContaining({ code: "SESSION_PARTICIPATION_REQUIRED" }),
              }),
            );
            expect(loadHandlers).toHaveBeenCalledOnce();
          } else {
            authorization.assertCurrent();
          }
          const before = progressCardStore.get(target.sessionKey, target.agentId);
          const get = vi.spyOn(progressCardStore, "get");
          const put = vi.spyOn(progressCardStore, "put");
          let storeCalls;
          try {
            release.resolve();
            await pending;
            storeCalls = { get: [...get.mock.calls], put: [...put.mock.calls] };
          } finally {
            get.mockRestore();
            put.mockRestore();
          }
          const after = progressCardStore.get(target.sessionKey, target.agentId);
          if (testCase.replace) {
            expect({
              responses: respond.mock.calls,
              after,
              storeCalls,
              events: broadcast.mock.calls,
            }).toEqual({
              responses: [
                [
                  false,
                  undefined,
                  expect.objectContaining({
                    code: "INVALID_REQUEST",
                    details: expect.objectContaining({
                      code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                    }),
                  }),
                ],
              ],
              after: before,
              storeCalls: { get: [], put: [] },
              events: [],
            });
          } else {
            const writing = testCase.method === "progressCard.put";
            expect(respond).toHaveBeenCalledWith(
              true,
              {
                card: expect.objectContaining({
                  markdown: writing ? "request update" : "original card",
                  revision: writing ? 2 : 1,
                }),
              },
              undefined,
            );
            expect(after?.markdown).toBe(writing ? "request update" : "original card");
            expect(broadcast).toHaveBeenCalledTimes(writing ? 1 : 0);
          }
        } finally {
          release.resolve();
          await pending;
        }
      });
    },
  );
});
