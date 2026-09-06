// Line tests cover probe plugin behavior.
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
  // The probe reads the webhook switch after the optional quota reads, so every
  // sequence that gets that far declares its answer rather than falling through to
  // the support stub's unexpected-request guard.
  const webhookResponse = (active: boolean) =>
    Response.json({ endpoint: "https://gateway.example/line/webhook", active });

  it("reports used allowance beside the bot identity", async () => {
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "limited", value: 200 }),
      Response.json({ totalUsage: 70 }),
      webhookResponse(true),
    );

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      ok: true,
      bot: identity,
      quota: { kind: "limited", limit: 200, used: 70 },
      webhook: { status: "active" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stays healthy and cancels an optional quota body before the probe deadline", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ type: "none" });
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      pending.response,
      webhookResponse(true),
    );
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(200);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.quota).toBeUndefined();
      // The stalled quota read spends only its own slice; the webhook read still gets
      // a bounded budget of what remains, so it runs rather than being starved.
      expect(fetchMock).toHaveBeenCalledTimes(3);
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
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "none" }),
      webhookResponse(true),
    );

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      ok: true,
      bot: identity,
      quota: { kind: "unlimited" },
    });
    expect(fetchMock.mock.calls.map(([url]) => resolveRequestUrl(url))).toEqual([
      "https://api.line.me/v2/bot/info",
      "https://api.line.me/v2/bot/message/quota",
      "https://api.line.me/v2/bot/channel/webhook/endpoint",
    ]);
  });

  it("keeps a limited response without an amount unknown", async () => {
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "limited" }),
      webhookResponse(true),
    );

    const result = await probeLineBot("token", 5000);
    expect(result).toMatchObject({ ok: true, bot: identity });
    expect(result.quota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a failed quota request unknown", async () => {
    const fetchMock = stubLineApiFetch(
      Response.json(identity),
      Response.json({ message: "Unauthorized" }, { status: 401 }),
      webhookResponse(true),
    );

    const result = await probeLineBot("token", 5000);
    expect(result).toMatchObject({ ok: true, bot: identity });
    expect(result.quota).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
      webhookResponse(true),
    );
    const completed: Array<LineMessageQuota | undefined> = [];
    // Identity leaves a two-second quota budget; renewing it for consumption would take 2.4s.
    const reading = probeLineBot("token", 4000).then((result) => {
      completed.push(result.quota);
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(2001);
      // Three LINE reads plus the webhook read that follows the exhausted quota budget.
      expect(fetchMock).toHaveBeenCalledTimes(4);
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

  it.each([
    { active: true, expected: "active" },
    { active: false, expected: "disabled" },
  ] as const)(
    "reports a registered webhook that is active=$active",
    async ({ active, expected }) => {
      stubLineApiFetch(
        Response.json(identity),
        Response.json({ type: "none" }),
        webhookResponse(active),
      );

      // LINE returns the registered URL; the probe deliberately does not carry it,
      // because it would then reach logs and status output with no action to take on it.
      await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
        webhook: { status: expected },
      });
    },
  );

  it("reports an unregistered webhook when LINE answers 404", async () => {
    stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "none" }),
      Response.json({ message: "Not found" }, { status: 404 }),
    );

    await expect(probeLineBot("token", 5000)).resolves.toMatchObject({
      webhook: { status: "unset" },
    });
  });

  // Any other failure is not evidence about the webhook, so the probe stays silent
  // rather than letting status claim the webhook is either fine or broken.
  it("leaves the webhook unreported when the endpoint call fails for another reason", async () => {
    stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "none" }),
      Response.json({ message: "Server error" }, { status: 500 }),
    );

    const result = await probeLineBot("token", 5000);
    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
  });

  // An answer that is not the documented boolean is not evidence either: reporting it
  // as disabled would send an operator to a console switch that is already on.
  it("leaves the webhook unreported when active is not a boolean", async () => {
    stubLineApiFetch(
      Response.json(identity),
      Response.json({ type: "none" }),
      Response.json({ endpoint: "https://gateway.example/line/webhook", active: "yes" }),
    );

    const result = await probeLineBot("token", 5000);
    expect(result.ok).toBe(true);
    expect(result.webhook).toBeUndefined();
  });

  // The webhook lookup is an optional extra inside the probe's deadline. If it could
  // spend that deadline, a healthy token would be reported as a broken channel.
  it("stays healthy when the webhook lookup never settles", async () => {
    vi.useFakeTimers();
    const pending = createPendingLineResponse({ endpoint: "https://x", active: true });
    stubLineApiFetch(Response.json(identity), Response.json({ type: "none" }), pending.response);
    const probing = probeLineBot("token", 300);
    try {
      await vi.advanceTimersByTimeAsync(299);
      const result = await probing;
      expect(result).toMatchObject({ ok: true, bot: identity });
      expect(result.webhook).toBeUndefined();
    } finally {
      pending.finish();
      await vi.runAllTimersAsync();
      await probing;
    }
  });

  it("still fails the probe when the bot identity call fails", async () => {
    const fetchMock = stubLineApiFetch(Response.json({ message: "Unauthorized" }, { status: 401 }));

    expect(await probeLineBot("token", 5000)).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
