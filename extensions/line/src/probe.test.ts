import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeLineBot } from "./probe.js";
import { createPendingLineResponse, stubLineApiFetch } from "./probe.test-support.js";
import type { LineMessageQuota } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("probeLineBot", () => {
  const identity = {
    displayName: "bot",
    userId: "U0",
    basicId: "@bot",
  };

  it("reports used allowance beside the bot identity", async () => {
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "limited", value: 200 }),
      Response.json({ totalUsage: 70 }),
    );

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      ok: true,
      bot: identity,
      quota: { kind: "limited", limit: 200, used: 70 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stays healthy and cancels an optional quota body before the probe deadline", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ type: "none" });
    const fetchMock = stubLineApiFetch(Response.json(identity), pending.response);
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(200);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.quota).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(pending.cancel).toHaveBeenCalledOnce();
    } finally {
      pending.finish();
      await vi.runAllTimersAsync();
      await probing;
    }
  });

  it("reports a failure when the bot identity itself cannot be read", async () => {
    const fetchMock = stubLineApiFetch(Response.json({ message: "Unauthorized" }, { status: 401 }));

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels a stalled bot identity read and reports a timeout", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse(identity);
    const fetchMock = stubLineApiFetch(pending.response);
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(301);
      expect(await probing).toMatchObject({ ok: false, error: "timeout" });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(pending.cancel).toHaveBeenCalledOnce();
    } finally {
      pending.finish();
      await vi.runAllTimersAsync();
      await probing;
    }
  });

  it("reports an explicit unlimited plan without reading consumption", async () => {
    const fetchMock = stubLineApiFetch(Response.json(identity), Response.json({ type: "none" }));

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      ok: true,
      bot: identity,
      quota: { kind: "unlimited" },
    });
    expect(fetchMock.mock.calls.map(([url]) => resolveRequestUrl(url))).toEqual([
      "https://api.line.me/v2/bot/info",
      "https://api.line.me/v2/bot/message/quota",
    ]);
  });

  it("keeps a limited response without an amount unknown", async () => {
    const fetchMock = stubLineApiFetch(Response.json(identity), Response.json({ type: "limited" }));

    const result = await probeLineBot("token", 5000);
    expect(result).toMatchObject({ ok: true, bot: identity });
    expect(result.quota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed quota request unknown", async () => {
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ message: "Unauthorized" }, { status: 401 }),
    );

    const result = await probeLineBot("token", 5000);
    expect(result).toMatchObject({ ok: true, bot: identity });
    expect(result.quota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares the optional quota deadline across both response bodies", async () => {
    vi.useFakeTimers();
    const bodies: ReturnType<typeof createPendingLineResponse>[] = [];
    const delayedBody = (value: unknown) => () => {
      const pending = createPendingLineResponse(value);
      bodies.push(pending);
      setTimeout(pending.finish, 1200);
      return pending.response;
    };
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      delayedBody({ type: "limited", value: 200 }),
      delayedBody({ totalUsage: 70 }),
    );
    const completed: Array<LineMessageQuota | undefined> = [];
    // Identity leaves a two-second quota budget; renewing it for consumption would take 2.4s.
    const reading = probeLineBot("token", 4000).then((result) => {
      completed.push(result.quota);
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(2001);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(bodies).toHaveLength(2);
      expect(completed).toEqual([undefined]);
      expect(await reading).toMatchObject({ ok: true, bot: identity });
      expect(bodies[1]?.cancel).toHaveBeenCalledOnce();
    } finally {
      for (const pending of bodies) {
        pending.finish();
      }
      await vi.runAllTimersAsync();
      await reading;
    }
  });
});
