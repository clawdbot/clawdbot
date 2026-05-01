import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeE164 } from "openclaw/plugin-sdk/text-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalToolResultConfig,
  config,
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();

// Import after the harness registers `vi.mock(...)` for Signal internals.
const { monitorSignalProvider } = await import("./monitor.js");

const {
  replyMock,
  sendMock,
  streamMock,
  updateLastRouteMock,
  enqueueSystemEventMock,
  upsertPairingRequestMock,
  waitForTransportReadyMock,
} = getSignalToolResultTestMocks();

const SIGNAL_BASE_URL = "http://127.0.0.1:8080";
type MonitorSignalProviderOptions = NonNullable<Parameters<typeof monitorSignalProvider>[0]>;

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider({
    config: config as OpenClawConfig,
    waitForTransportReady:
      waitForTransportReadyMock as MonitorSignalProviderOptions["waitForTransportReady"],
    ...opts,
  });
}

async function receiveSignalPayloads(params: {
  payloads: unknown[];
  opts?: Partial<MonitorSignalProviderOptions>;
}) {
  const abortController = new AbortController();
  streamMock.mockImplementation(async ({ onEvent }) => {
    for (const payload of params.payloads) {
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
    }
    abortController.abort();
  });

  await runMonitorWithMocks({
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    abortSignal: abortController.signal,
    ...params.opts,
  });

  await flush();
}

function hasQueuedReactionEventFor(sender: string) {
  const route = resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: "signal",
    accountId: "default",
    peer: { kind: "direct", id: normalizeE164(sender) },
  });
  return enqueueSystemEventMock.mock.calls.some(([text, options]) => {
    return (
      typeof text === "string" &&
      text.includes("Signal reaction added") &&
      typeof options === "object" &&
      options !== null &&
      "sessionKey" in options &&
      (options as { sessionKey?: string; trusted?: boolean }).sessionKey === route.sessionKey &&
      (options as { trusted?: boolean }).trusted === false
    );
  });
}

function makeBaseEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    sourceNumber: "+15550001111",
    sourceName: "Ada",
    timestamp: 1,
    ...overrides,
  };
}

async function receiveSingleEnvelope(
  envelope: Record<string, unknown>,
  opts?: Partial<MonitorSignalProviderOptions>,
) {
  await receiveSignalPayloads({
    payloads: [{ envelope }],
    opts,
  });
}

function expectNoReplyDeliveryOrRouteUpdate() {
  expect(replyMock).not.toHaveBeenCalled();
  expect(sendMock).not.toHaveBeenCalled();
  expect(updateLastRouteMock).not.toHaveBeenCalled();
}

function setReactionNotificationConfig(mode: "all" | "own", extra: Record<string, unknown> = {}) {
  setSignalToolResultTestConfig(
    createSignalToolResultConfig({
      autoStart: false,
      dmPolicy: "open",
      allowFrom: ["*"],
      reactionNotifications: mode,
      ...extra,
    }),
  );
}

describe("monitorSignalProvider tool results", () => {
  it("skips tool summaries with responsePrefix", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "hello",
            },
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] }),
    );
    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "hello",
            },
          },
        },
      ],
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expectPairingReplyText(String(sendMock.mock.calls[0]?.[1] ?? ""), {
      channel: "signal",
      idLine: "Your Signal number: +15550001111",
      code: "PAIRCODE",
    });
  });

  it("ignores reaction-only messages", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "👍",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2,
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("ignores reaction-only dataMessage.reaction events (don’t treat as broken attachments)", async () => {
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      dataMessage: {
        reaction: {
          emoji: "👍",
          targetAuthor: "+15550002222",
          targetSentTimestamp: 2,
        },
        attachments: [{}],
      },
    });

    expectNoReplyDeliveryOrRouteUpdate();
  });

  it("enqueues system events for reaction notifications", async () => {
    setReactionNotificationConfig("all");
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor: "+15550002222",
        targetSentTimestamp: 2,
      },
    });

    expect(hasQueuedReactionEventFor("+15550001111")).toBe(true);
  });

  it.each([
    {
      name: "blocks reaction notifications from unauthorized senders when dmPolicy is allowlist",
      mode: "all" as const,
      extra: { dmPolicy: "allowlist", allowFrom: ["+15550007777"] } as Record<string, unknown>,
      targetAuthor: "+15550002222",
      shouldEnqueue: false,
    },
    {
      name: "blocks reaction notifications from unauthorized senders when dmPolicy is pairing",
      mode: "own" as const,
      extra: {
        dmPolicy: "pairing",
        allowFrom: [],
        account: "+15550009999",
      } as Record<string, unknown>,
      targetAuthor: "+15550009999",
      shouldEnqueue: false,
    },
    {
      name: "allows reaction notifications for allowlisted senders when dmPolicy is allowlist",
      mode: "all" as const,
      extra: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } as Record<string, unknown>,
      targetAuthor: "+15550002222",
      shouldEnqueue: true,
    },
  ])("$name", async ({ mode, extra, targetAuthor, shouldEnqueue }) => {
    setReactionNotificationConfig(mode, extra);
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor,
        targetSentTimestamp: 2,
      },
    });

    expect(hasQueuedReactionEventFor("+15550001111")).toBe(shouldEnqueue);
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("notifies on own reactions when target includes uuid + phone", async () => {
    setReactionNotificationConfig("own", { account: "+15550002222" });
    await receiveSingleEnvelope({
      ...makeBaseEnvelope(),
      reactionMessage: {
        emoji: "✅",
        targetAuthor: "+15550002222",
        targetAuthorUuid: "123e4567-e89b-12d3-a456-426614174000",
        targetSentTimestamp: 2,
      },
    });

    expect(hasQueuedReactionEventFor("+15550001111")).toBe(true);
  });

  it("processes messages when reaction metadata is present", async () => {
    replyMock.mockResolvedValue({ text: "pong" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            reactionMessage: {
              emoji: "👍",
              targetAuthor: "+15550002222",
              targetSentTimestamp: 2,
            },
            dataMessage: {
              message: "ping",
            },
          },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not resend pairing code when a request is already pending", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, dmPolicy: "pairing", allowFrom: [] }),
    );
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const payload = {
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Ada",
        timestamp: 1,
        dataMessage: {
          message: "hello",
        },
      },
    };
    await receiveSignalPayloads({
      payloads: [
        payload,
        {
          ...payload,
          envelope: { ...payload.envelope, timestamp: 2 },
        },
      ],
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
