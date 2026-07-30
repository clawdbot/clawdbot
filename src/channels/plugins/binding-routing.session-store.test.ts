// Exercises runtime binding route resolution against a real SQLite session store,
// with no session-accessor mocking, so the stale-target fallback is proven end to end.
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  registerSessionBindingAdapter,
  testing,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resolveRuntimeConversationBindingRoute } from "./binding-routing.js";

const tempDirs: string[] = [];

const LIVE_SESSION_KEY = "agent:review:acp:live-session";
const DELETED_SESSION_KEY = "agent:review:acp:deleted-session";

function createRoute(): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "demo",
    accountId: "default",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "main",
    matchedBy: "default",
  };
}

function registerAdapter(targetSessionKey: string): void {
  const record: SessionBindingRecord = {
    bindingId: "binding-1",
    targetSessionKey,
    targetKind: "session",
    conversation: {
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    },
    status: "active",
    boundAt: 1,
  };
  registerSessionBindingAdapter({
    channel: "demo",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: () => record,
    touch: () => {},
  });
}

function resolveRoute(route: ResolvedAgentRoute) {
  return resolveRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    },
  });
}

afterEach(() => {
  testing.resetSessionBindingAdaptersForTests();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("runtime conversation binding route against the real session store", () => {
  it("routes to a bound session that still exists in the store", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-binding-live-session-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await upsertSessionEntry(
        { agentId: "review", sessionKey: LIVE_SESSION_KEY },
        { sessionId: "session-1", updatedAt: 10 },
      );
      registerAdapter(LIVE_SESSION_KEY);

      const result = resolveRoute(createRoute());

      expect(result.bindingRecord).not.toBeNull();
      expect(result.boundSessionKey).toBe(LIVE_SESSION_KEY);
      expect(result.route.agentId).toBe("review");
      expect(result.route.sessionKey).toBe(LIVE_SESSION_KEY);
    });
  });

  it("falls back to the caller's route when the bound session is gone from the store", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-binding-stale-session-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      // Only the live session is persisted; the binding points at a session key the
      // store cannot resolve, which is the state left behind when a session is pruned.
      await upsertSessionEntry(
        { agentId: "review", sessionKey: LIVE_SESSION_KEY },
        { sessionId: "session-1", updatedAt: 10 },
      );
      registerAdapter(DELETED_SESSION_KEY);

      const route = createRoute();
      const result = resolveRoute(route);

      // A null record is what lets the caller keep its configured binding instead of
      // being stranded on the dead target.
      expect(result.bindingRecord).toBeNull();
      expect(result.boundSessionKey).toBeUndefined();
      expect(result.route).toBe(route);
      expect(result.route.agentId).toBe("main");
    });
  });
});
