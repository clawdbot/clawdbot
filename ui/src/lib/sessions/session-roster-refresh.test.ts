// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("session roster refresh completion", () => {
  it("settles coalesced refresh callers after their snapshot without waiting for later work", async () => {
    const initialList = createDeferred<SessionsListResult>();
    const coalescedList = createDeferred<SessionsListResult>();
    const laterList = createDeferred<SessionsListResult>();
    const request = vi.fn(async (method: string, params?: { search?: string }) => {
      expect(method).toBe("sessions.list");
      switch (params?.search) {
        case "initial":
          return await initialList.promise;
        case "coalesced":
          return await coalescedList.promise;
        case "later":
          return await laterList.promise;
        default:
          throw new Error(`Unexpected refresh: ${params?.search}`);
      }
    });
    const { sessions } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const initialSettled = vi.fn();
    const coalescedSettled = vi.fn();
    const initial = sessions.refresh({ search: "initial", force: true }).then(initialSettled);
    const first = sessions.refresh({ search: "superseded", force: true }).then(coalescedSettled);
    const second = sessions.refresh({ search: "coalesced", force: true }).then(coalescedSettled);
    let later: Promise<void> | undefined;

    try {
      expect(sessions.state.loading).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      initialList.resolve(sessionsResult([], 1));
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(initialSettled).toHaveBeenCalledOnce());
      expect(coalescedSettled).not.toHaveBeenCalled();

      later = sessions.refresh({ search: "later", force: true });
      coalescedList.resolve(sessionsResult([], 2));
      await waitForFast(() => expect(coalescedSettled).toHaveBeenCalledTimes(2));

      expect(sessions.state.result?.ts).toBe(2);
      expect(sessions.state.loading).toBe(true);
      expect(request.mock.calls.map(([, params]) => params?.search)).toEqual([
        "initial",
        "coalesced",
        "later",
      ]);
      laterList.resolve(sessionsResult([], 3));
      await later;
      expect(sessions.state.result?.ts).toBe(3);
      expect(sessions.state.loading).toBe(false);
    } finally {
      initialList.resolve(sessionsResult([], 1));
      coalescedList.resolve(sessionsResult([], 2));
      laterList.resolve(sessionsResult([], 3));
      sessions.dispose();
      await Promise.all([initial, first, second, later]);
    }
  });

  it.each(["disconnect", "same-client reconnect", "replacement-client reconnect", "dispose"])(
    "settles unissued refreshes on %s without dispatching them through a replacement owner",
    async (retirement) => {
      const activeList = createDeferred<SessionsListResult>();
      const refreshed = sessionsResult([], 2);
      const request = vi.fn(async (method: string, params?: { search?: string }) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: refreshed };
        }
        if (method === "sessions.list" && params?.search === "active") {
          return await activeList.promise;
        }
        throw new Error(`Unexpected request: ${method} ${params?.search}`);
      });
      const replacementRequest = vi.fn(async (method: string, _params?: { search?: string }) => {
        expect(method).toBe("sessions.subscribe");
        return { subscribed: true, list: refreshed };
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const replacement = { request: replacementRequest } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      const sessions = createSessionCapability(gateway);
      const retired = vi.fn();
      const active = sessions.refresh({ search: "active", force: true });
      const first = sessions.refresh({ search: "unissued-first", force: true }).then(retired);
      const second = sessions.refresh({ search: "unissued-second", force: true }).then(retired);

      try {
        expect(request).toHaveBeenCalledTimes(1);
        if (retirement === "dispose") {
          sessions.dispose();
        } else {
          publish(false);
          if (retirement !== "disconnect") {
            publish(true, retirement === "same-client reconnect" ? client : replacement);
          }
        }
        await waitForFast(() => expect(retired).toHaveBeenCalledTimes(2));
        if (retirement.endsWith("reconnect")) {
          await waitForFast(() => expect(sessions.state.result?.ts).toBe(2));
        }

        activeList.resolve(sessionsResult([], 1));
        await active;
        expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
        expect(replacementRequest.mock.calls.some(([method]) => method === "sessions.list")).toBe(
          false,
        );
        if (retirement.endsWith("reconnect")) {
          expect(sessions.state.result?.ts).toBe(2);
        } else if (retirement === "disconnect") {
          expect(sessions.state.result).toBeNull();
        }
      } finally {
        activeList.resolve(sessionsResult([], 1));
        sessions.dispose();
        await Promise.all([active, first, second]);
      }
    },
  );
});
