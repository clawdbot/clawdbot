// Signal tests cover monitor.tool result.sends tool summaries responseprefix plugin behavior.
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalToolResultConfig,
  config,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
  toSignalToolResultTestError,
  waitForSignalToolResultIngressIdle,
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

function waitForSignalDelivery(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1, timeout: 5_000 });
}

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
  let ingressIdleError: Error | undefined;
  streamMock.mockImplementation(async ({ onEvent }) => {
    for (const payload of params.payloads) {
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
    }
    try {
      await waitForSignalToolResultIngressIdle();
    } catch (error) {
      ingressIdleError = toSignalToolResultTestError(error, "Signal ingress did not become idle");
    } finally {
      abortController.abort();
    }
  });

  await runMonitorWithMocks({
    autoStart: false,
    baseUrl: SIGNAL_BASE_URL,
    abortSignal: abortController.signal,
    ...params.opts,
  });
  if (ingressIdleError) {
    throw ingressIdleError;
  }
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
      (options as { sessionKey?: string }).sessionKey === route.sessionKey
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

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[1]).toBe("PFX final reply");
  });

  it("passes inbound Signal quote metadata to final replies", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "quote me",
    });
  });

  it("passes UUID-only inbound Signal quote metadata to final replies", async () => {
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "123e4567-e89b-12d3-a456-426614174000",
      replyToBody: "quote me",
    });
  });

  it("passes group inbound quote metadata through group reply mode overrides", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        groupPolicy: "open",
        replyToMode: "off",
        replyToModeByChatType: { group: "all" },
      }),
    );
    replyMock.mockResolvedValue({ text: "group reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "group quote me",
              groupInfo: {
                groupId: "signal-group-id",
                groupName: "Testing realm",
              },
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[0]).toBe("group:signal-group-id");
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "group quote me",
    });
  });

  it("uses native quote metadata on every implicit chunk when configured for all replies", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "all",
        textChunkLimit: 8,
      }),
    );
    replyMock.mockResolvedValue({ text: "chunked Signal reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock.mock.calls.length).toBeGreaterThan(1);
    });
    for (const call of sendMock.mock.calls) {
      expect(call[2]).toMatchObject({
        replyToId: "1700000000001",
        replyToAuthor: "+15550001111",
        replyToBody: "quote me",
      });
    }
  });

  it("uses native quote metadata only on the first implicit chunk when configured", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "first",
        textChunkLimit: 8,
      }),
    );
    replyMock.mockResolvedValue({ text: "chunked Signal reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock.mock.calls.length).toBeGreaterThan(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "quote me",
    });
    for (const call of sendMock.mock.calls.slice(1)) {
      expect(call[2]).not.toHaveProperty("replyToId");
      expect(call[2]).not.toHaveProperty("replyToAuthor");
      expect(call[2]).not.toHaveProperty("replyToBody");
    }
  });

  it("uses native quote metadata only on the first implicit payload when configured", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "first",
      }),
    );
    replyMock.mockResolvedValue([{ text: "first reply" }, { text: "second reply" }]);

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(2);
    });
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "quote me",
    });
    expect(sendMock.mock.calls[1]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[1]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[1]?.[2]).not.toHaveProperty("replyToBody");
  });

  it.each([
    ["status", { isStatusNotice: true }],
    ["fallback", { isFallbackNotice: true }],
    ["compaction", { isCompactionNotice: true }],
  ] as const)(
    "does not let %s notices consume the first native quote slot",
    async (_name, flag) => {
      setSignalToolResultTestConfig(
        createSignalToolResultConfig({
          autoStart: false,
          replyToMode: "first",
        }),
      );
      replyMock.mockResolvedValue([{ text: "working", ...flag }, { text: "final reply" }]);

      await receiveSignalPayloads({
        payloads: [
          {
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Ada",
              timestamp: 1700000000001,
              dataMessage: {
                message: "quote me",
              },
            },
          },
        ],
      });

      await waitForSignalDelivery(() => {
        expect(sendMock).toHaveBeenCalledTimes(2);
      });
      for (const call of sendMock.mock.calls) {
        expect(call[2]).toMatchObject({
          replyToId: "1700000000001",
          replyToAuthor: "+15550001111",
          replyToBody: "quote me",
        });
      }
    },
  );

  it.each([
    ["status", { isStatusNotice: true }],
    ["fallback", { isFallbackNotice: true }],
    ["compaction", { isCompactionNotice: true }],
  ] as const)(
    "keeps %s notices quoted after the first normal native reply",
    async (_name, flag) => {
      setSignalToolResultTestConfig(
        createSignalToolResultConfig({
          autoStart: false,
          replyToMode: "first",
        }),
      );
      replyMock.mockResolvedValue([{ text: "final reply" }, { text: "still working", ...flag }]);

      await receiveSignalPayloads({
        payloads: [
          {
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Ada",
              timestamp: 1700000000001,
              dataMessage: {
                message: "quote me",
              },
            },
          },
        ],
      });

      await waitForSignalDelivery(() => {
        expect(sendMock).toHaveBeenCalledTimes(2);
      });
      for (const call of sendMock.mock.calls) {
        expect(call[2]).toMatchObject({
          replyToId: "1700000000001",
          replyToAuthor: "+15550001111",
          replyToBody: "quote me",
        });
      }
    },
  );

  it.each([
    ["status", { isStatusNotice: true }],
    ["fallback", { isFallbackNotice: true }],
    ["compaction", { isCompactionNotice: true }],
  ] as const)("does not quote %s notices when native quote mode is off", async (_name, flag) => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "off",
      }),
    );
    replyMock.mockResolvedValue([{ text: "working", ...flag }]);

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
  });

  it("does not implicitly quote a single-message batched-mode turn", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "batched",
      }),
    );
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
  });

  it("keeps durable conversation events separate in batched reply mode", async () => {
    setSignalToolResultTestConfig({
      ...createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "batched",
      }),
      messages: { inbound: { debounceMs: 10 } },
    });
    replyMock.mockResolvedValue({ text: "reply" });
    const abortController = new AbortController();
    let ingressIdleError: Error | undefined;
    streamMock.mockImplementation(async ({ onEvent }) => {
      for (const [timestamp, message] of [
        [1700000000001, "first message"],
        [1700000000002, "second message"],
      ] as const) {
        await onEvent({
          event: "receive",
          data: JSON.stringify({
            envelope: {
              sourceNumber: "+15550001111",
              sourceName: "Ada",
              timestamp,
              dataMessage: { message },
            },
          }),
        });
      }
      try {
        await waitForSignalDelivery(() => {
          expect(replyMock).toHaveBeenCalledTimes(2);
        });
        await waitForSignalToolResultIngressIdle();
      } catch (error) {
        ingressIdleError = toSignalToolResultTestError(
          error,
          "Batched Signal ingress did not become idle",
        );
      } finally {
        abortController.abort();
      }
    });

    await runMonitorWithMocks({
      autoStart: false,
      baseUrl: SIGNAL_BASE_URL,
      abortSignal: abortController.signal,
    });
    if (ingressIdleError) {
      throw ingressIdleError;
    }

    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expect(call[2]).not.toHaveProperty("replyToId");
      expect(call[2]).not.toHaveProperty("replyToAuthor");
      expect(call[2]).not.toHaveProperty("replyToBody");
    }
  });

  it("passes inbound Signal quote metadata to media replies", async () => {
    replyMock.mockResolvedValue({ text: "caption", mediaUrl: "https://example.com/reply.png" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      mediaUrl: "https://example.com/reply.png",
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "quote me",
    });
  });

  it("does not attach native quote metadata for a different explicit reply target", async () => {
    replyMock.mockResolvedValue({ text: "final reply", replyToId: "1700000000999" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
  });

  it("does not attach native quote metadata when the reply opts out of the current message", async () => {
    replyMock.mockResolvedValue({ text: "status reply", replyToCurrent: false });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
  });

  it("does not reconstruct native quote metadata when replyToMode strips threading", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, replyToMode: "off" }),
    );
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
  });

  it("keeps explicit current-message native quote metadata when reply mode is off", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({ autoStart: false, replyToMode: "off" }),
    );
    replyMock.mockResolvedValue({ text: "final reply", replyToCurrent: true });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).toMatchObject({
      replyToId: "1700000000001",
      replyToAuthor: "+15550001111",
      replyToBody: "quote me",
    });
  });

  it("lets direct chat replyToMode override channel default quote settings", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToMode: "all",
        replyToModeByChatType: { direct: "off" },
      }),
    );
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
  });

  it("lets account replyToMode override channel chat-type quote settings", async () => {
    setSignalToolResultTestConfig(
      createSignalToolResultConfig({
        autoStart: false,
        replyToModeByChatType: { direct: "all" },
        accounts: {
          default: {
            replyToMode: "off",
          },
        },
      }),
    );
    replyMock.mockResolvedValue({ text: "final reply" });

    await receiveSignalPayloads({
      payloads: [
        {
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1700000000001,
            dataMessage: {
              message: "quote me",
            },
          },
        },
      ],
    });

    await waitForSignalDelivery(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToId");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToAuthor");
    expect(sendMock.mock.calls[0]?.[2]).not.toHaveProperty("replyToBody");
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

    await waitForSignalDelivery(() => {
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
