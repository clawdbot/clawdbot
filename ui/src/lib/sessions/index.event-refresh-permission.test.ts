// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each([
  { eventKey: "agent:research:other", outcome: "success" },
  { eventKey: "agent:research:other", outcome: "failure" },
  { eventKey: "agent:main:other", outcome: "success" },
  { eventKey: "agent:main:other", outcome: "failure" },
  { eventKey: "agent:main:visible", outcome: "success" },
  { eventKey: "agent:main:visible", outcome: "failure" },
])(
  "settles a roster refresh $outcome during an active message for $eventKey",
  async ({ eventKey, outcome }) => {
    vi.useFakeTimers();
    const key = "agent:main:visible";
    const row = { key, kind: "direct" as const, sessionId: "visible-generation", updatedAt: 1 };
    const initial = sessionsResult([row], 1);
    const response = sessionsResult([{ ...row, label: "Refreshed", updatedAt: 3 }], 3);
    const pending = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return listCalls === 1 ? initial : pending.promise;
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ agentId: "main", force: true });
      const refresh = sessions.refresh({ agentId: "main", force: true });
      expect(listCalls).toBe(2);
      expect(sessions.state.loading).toBe(true);

      emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: eventKey,
          key: eventKey,
          kind: "direct",
          sessionId: eventKey === key ? row.sessionId : "other-generation",
          updatedAt: 2,
          archived: false,
          permissionMode: null,
          hasActiveRun: true,
          status: "running",
        },
      });
      if (outcome === "success") {
        pending.resolve(response);
      } else {
        pending.reject(new Error("Roster refresh unavailable"));
      }
      await refresh;
      await vi.runAllTimersAsync();

      expect.soft(sessions.state.loading).toBe(false);
      expect.soft(listCalls).toBe(2);
      if (outcome === "success") {
        expect.soft(sessions.state.result?.sessions).toEqual(response.sessions);
        expect.soft(sessions.state.error).toBeNull();
      } else {
        expect.soft(sessions.state.error).toBe("Roster refresh unavailable");
      }
    } finally {
      pending.resolve(response);
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);
