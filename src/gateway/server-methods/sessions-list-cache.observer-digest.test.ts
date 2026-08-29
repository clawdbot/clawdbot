import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { defaultPersistDigest } from "../session-observer-model.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { respondWithCachedSessionList } from "./sessions-list-cache.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

function result(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key: "agent:main:observer-fence", kind: "direct", updatedAt: 1 }],
  };
}

it("invalidates a cached sessions.list result after an observer-digest persist", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config: OpenClawConfig = {};
    const context = {} as unknown as GatewayRequestContext;
    const client = {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      },
      authenticatedUserProfile: {
        profileId: "owner@example.com",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
    } as GatewayClient;
    const request = { archived: "all" as const, limit: 100 };
    let calls = 0;
    const requestList = async () => {
      let response: SessionsListResult | undefined;
      await respondWithCachedSessionList({
        client,
        config,
        context,
        request,
        respond: (ok, payload) => {
          expect(ok).toBe(true);
          response = payload as SessionsListResult;
        },
        run: async () => {
          calls += 1;
          return result();
        },
      });
      return response;
    };

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:observer-fence" },
      { sessionId: "observer-fence", updatedAt: 1 },
    );
    const first = await requestList();
    expect(await requestList()).toBe(first);
    expect(calls).toBe(1);

    // The session sidebar row renders observerDigest headline/health; a digest
    // write with no other session mutation must still evict the cached page.
    await defaultPersistDigest({
      sessionKey: "agent:main:observer-fence",
      sessionId: "observer-fence",
      agentId: "main",
      digest: {
        sessionKey: "agent:main:observer-fence",
        runId: "run-1",
        revision: 1,
        updatedAt: 2,
        headline: "Reviewing changes",
        health: "on-track",
      },
    });
    expect(await requestList()).not.toBe(first);
    expect(calls).toBe(2);
  });
});
