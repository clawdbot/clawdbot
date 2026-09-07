/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import { createContext, createSessionsHarness } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { rosterActivityStore } from "./roster-activity-store.ts";

function result(preview: string, hasMore = false): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions: [{ key: "agent:main:main", kind: "direct", lastMessagePreview: preview }],
    hasMore,
  };
}

describe("roster activity lifecycle", () => {
  it.each(["reconnect", "replace client", "detach"] as const)(
    "retires in-flight pagination on %s and loads a fresh snapshot on return",
    async (transition) => {
      const stale = createDeferred<SessionsListResult>();
      const list = vi
        .fn()
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValue(result("Current activity"));
      const request = createGatewayRequestMock(async (method) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          return list();
        }
        throw new Error(`Unexpected RPC: ${method}`);
      });
      const client = createTestGatewayClient(request);
      const source = createApplicationGateway({
        client,
        phase: "connected",
        hello: null,
        offlineStable: false,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: "main",
        sessionKey: "agent:main:main",
        lastError: null,
        lastErrorCode: null,
      });
      const stopEvents = vi.fn();
      source.gateway.subscribeEvents = vi.fn(() => stopEvents);
      const context = createContext(source.gateway, createSessionsHarness("main", []).sessions, {
        agents: [{ id: "main" }],
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
      });
      const store = rosterActivityStore(context);
      const notify = vi.fn();
      let detach = store.subscribe(notify);
      try {
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
        if (transition === "detach") {
          detach();
          expect(stopEvents).toHaveBeenCalledTimes(1);
          expect(store.snapshot.cards).toEqual([]);
          detach = store.subscribe(notify);
        } else if (transition === "reconnect") {
          source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
          expect(store.snapshot.cards).toEqual([]);
          source.publish({ ...source.gateway.snapshot, phase: "connected" });
        } else {
          source.publish({ ...source.gateway.snapshot, client: createTestGatewayClient(request) });
        }
        await vi.waitFor(() => expect(store.snapshot.cards[0]?.preview).toBe("Current activity"));
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.subscribe"),
        ).toHaveLength(2);
        notify.mockClear();
        // Even a transport that resolves after abort must not publish or fetch another page.
        stale.resolve(result("Retired activity", true));
        await stale.promise;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(store.snapshot.cards[0]?.preview).toBe("Current activity");
        expect(notify).not.toHaveBeenCalled();
      } finally {
        detach();
      }
    },
  );
});
