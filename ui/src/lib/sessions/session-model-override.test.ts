// @vitest-environment node
// Focused model-override lifecycle coverage; the main capability suite sits
// at the max-lines cap.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("session model override lifecycle", () => {
  it.each(["resolve", "reject"])(
    "does not resurrect a deleted session's model when its pending patch %s",
    async (outcome) => {
      const pending = createDeferred<unknown>();
      const key = "agent:main:main";
      let patchCount = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.patch") {
          return ++patchCount === 1 ? { ok: true, key, entry: {} } : pending.promise;
        }
        if (method === "sessions.delete") {
          return { deleted: true };
        }
        if (method === "sessions.list") {
          return sessionsResult([], 2);
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
      const sessions = createTestSessionCapability(gateway);
      await sessions.patch(key, { model: "openai/gpt-old" }, { deferListRefresh: true });
      const operation = sessions.patch(
        key,
        { model: "openai/gpt-new" },
        { deferListRefresh: true },
      );
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-new");
      await expect(sessions.delete(key)).resolves.toMatchObject({ deleted: true });
      expect(sessions.state.modelOverrides).toEqual({});
      if (outcome === "resolve") {
        pending.resolve({ ok: true, key, entry: {} });
        await operation;
      } else {
        pending.reject(new Error("model rejected"));
        await expect(operation).rejects.toThrow("model rejected");
      }
      expect(sessions.state.modelOverrides).toEqual({});
      sessions.dispose();
    },
  );

  it("retains a confirmed patch without publishing its retired optimistic state", async () => {
    const stalePatch = createDeferred<unknown>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return await stalePatch.promise;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    const key = "agent:main:main";
    const inactiveKey = "agent:main:inactive";
    const inactiveOperation = sessions.patch(inactiveKey, { model: "openai/gpt-old-account" });

    const operation = sessions.patch(key, { model: "openai/gpt-new" });
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-new");

    publish(false);
    expect(sessions.state.modelOverrides).toEqual({});
    publish(true);
    stalePatch.resolve({ ok: true, path: "", key, entry: {} });

    await expect(operation).resolves.toMatchObject({ ok: true, key });
    await inactiveOperation;
    expect(sessions.state.modelOverrides).toEqual({});
    expect(sessions.state.error).toContain("completed on the previous connection");
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.list").length,
    ).toBeGreaterThan(0);
    sessions.dispose();
  });

  it("retires the model override after a confirmed patch so external changes reach the row", async () => {
    const key = "agent:main:main";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true, path: "", key, entry: { sessionId: "main-session" } };
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult(
          [{ key, kind: "direct", sessionId: "main-session", updatedAt: 10, model: "gpt-new" }],
          10,
        );
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.patch(key, { model: "openai/gpt-new" })).resolves.toMatchObject({
      ok: true,
    });

    // The refreshed row carries the confirmed selection; a retained local
    // override would shadow any later external model change (second window,
    // channel /model, fallback rotation) for the connection lifetime.
    expect(sessions.state.modelOverrides).toEqual({});
    expect(sessions.state.result?.sessions[0]?.model).toBe("gpt-new");
    sessions.dispose();
  });

  it("does not dispatch a queued patch on a replacement connection", async () => {
    const priorPatch = createDeferred();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true, path: "", key: "agent:main:main", entry: {} };
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    const key = "agent:main:main";

    const operation = sessions.patch(
      key,
      { model: "openai/gpt-new" },
      { waitFor: priorPatch.promise },
    );
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());

    publish(false);
    publish(true);
    priorPatch.resolve();

    await expect(operation).resolves.toBeNull();
    expect(request).not.toHaveBeenCalledWith("sessions.patch", expect.anything());
    expect(sessions.state.modelOverrides[key]).toBeUndefined();
    sessions.dispose();
  });
});
