import { expect, it } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { defaultPersistDigest } from "../session-observer-model.js";
import { listSessionsFromStoreAsync } from "../session-utils-list.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { respondWithCachedSessionList } from "./sessions-list-cache.js";

it("invalidates a cached sessions.list result after an observer-digest persist", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config: OpenClawConfig = {};
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const sessionKey = "agent:main:observer-fence";
    const request = { archived: "all" as const, limit: 100 };
    let calls = 0;
    const requestList = async () => {
      let response: SessionsListResult | undefined;
      await respondWithCachedSessionList({
        client: null,
        config,
        context,
        request,
        respond: (ok, payload) => {
          expect(ok).toBe(true);
          response = payload as SessionsListResult;
        },
        run: async () => {
          calls += 1;
          const entry = loadSessionEntry({ sessionKey, agentId: "main" });
          if (!entry) {
            throw new Error("session entry missing");
          }
          return await listSessionsFromStoreAsync({
            cfg: config,
            storePath: "",
            store: { [sessionKey]: entry },
            opts: request,
          });
        },
      });
      return response;
    };

    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "observer-fence", updatedAt: 1 },
    );
    const first = await requestList();
    expect(first?.sessions[0]?.observerDigest).toBeUndefined();
    expect(await requestList()).toBe(first);
    expect(calls).toBe(1);

    // The session sidebar row renders observerDigest headline/health; a digest
    // write with no other session mutation must still evict the cached page.
    await defaultPersistDigest({
      sessionKey,
      sessionId: "observer-fence",
      agentId: "main",
      digest: {
        sessionKey,
        runId: "run-1",
        revision: 1,
        updatedAt: 2,
        headline: "Reviewing changes",
        health: "on-track",
      },
    });
    const second = await requestList();
    expect(second).not.toBe(first);
    expect(second?.sessions[0]?.observerDigest).toMatchObject({
      headline: "Reviewing changes",
      health: "on-track",
    });
    expect(calls).toBe(2);
  });
});
