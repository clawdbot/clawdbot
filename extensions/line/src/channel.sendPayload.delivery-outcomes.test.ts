import { HTTPFetchError } from "@line/bot-sdk";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it } from "vitest";
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
