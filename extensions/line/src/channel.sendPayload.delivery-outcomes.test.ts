import { HTTPFetchError } from "@line/bot-sdk";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { createRuntime } from "./channel.sendPayload.test-support.js";
import { lineOutboundAdapter } from "./outbound.js";
import { setLineRuntime } from "./runtime.js";

describe("line outbound delivery outcomes", () => {
  it.each([
    { status: 400, retryable: false },
    { status: 429, retryable: true },
  ])("reports an initial LINE $status as a non-dispatch", async ({ status, retryable }) => {
    const { runtime, mocks } = createRuntime();
    const rejection = new HTTPFetchError(`${status} - provider rejection`, {
      status,
      statusText: "provider rejection",
      headers: new Headers(),
      body: "provider rejection",
    });
    mocks.pushMessageLine.mockRejectedValueOnce(rejection);
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      }),
    ).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      retryable,
      cause: rejection,
    });
  });

  it.each([
    {
      label: "settles and names the allowance when it is used up",
      quota: { kind: "limited", limit: 200, used: 200 } as const,
      retryable: false,
      reason: "200/200 monthly messages used",
    },
    {
      label: "stays retryable while the allowance still has room",
      quota: { kind: "limited", limit: 200, used: 12 } as const,
      retryable: true,
      reason: "429 - Too Many Requests",
    },
    {
      label: "stays retryable when the allowance cannot be read",
      quota: undefined,
      retryable: true,
      reason: "429 - Too Many Requests",
    },
  ])("$label", async ({ quota, retryable, reason }) => {
    const { runtime, mocks } = createRuntime();
    // LINE answers a spent monthly allowance and an ordinary rate limit with the
    // same 429, so only the quota separates "try again shortly" from "nothing
    // will send until next month".
    const rejection = new HTTPFetchError("429 - Too Many Requests", {
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      body: JSON.stringify({ message: "You have reached your monthly limit." }),
    });
    mocks.pushMessageLine.mockRejectedValueOnce(rejection);
    mocks.readAccountMessageQuota.mockResolvedValue(quota);
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      }),
    ).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      retryable,
      message: expect.stringContaining(reason),
    });
  });

  it("keeps a stalled allowance from holding back a retryable refusal", async () => {
    // The refusal already has a verdict. If asking about the allowance stalls,
    // durable delivery must still get its retryable 429 promptly instead of
    // waiting on an endpoint that may never answer.
    vi.useFakeTimers();
    try {
      const { runtime, mocks } = createRuntime();
      const rejection = new HTTPFetchError("429 - Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers(),
        body: JSON.stringify({ message: "You have reached your monthly limit." }),
      });
      mocks.pushMessageLine.mockRejectedValueOnce(rejection);
      mocks.readAccountMessageQuota.mockImplementation(() => new Promise(() => {}));
      setLineRuntime(runtime);

      const sent = lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      });
      const settled = expect(sent).rejects.toMatchObject({
        name: "PlatformMessageNotDispatchedError",
        retryable: true,
        message: "429 - Too Many Requests",
      });
      await vi.advanceTimersByTimeAsync(2_500);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves partial delivery evidence with a nested LINE rejection", async () => {
    const { runtime, mocks } = createRuntime();
    const rejection = new HTTPFetchError("400 - provider rejection", {
      status: 400,
      statusText: "provider rejection",
      headers: new Headers(),
      body: "provider rejection",
    });
    const partial = createChannelPartialDeliveryError(rejection, {
      messageIds: ["accepted-first"],
      visibleReplySent: true,
    });
    mocks.pushMessageLine.mockRejectedValueOnce(partial);
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "hello",
        payload: { text: "hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      }),
    ).rejects.toBe(partial);
  });
});
