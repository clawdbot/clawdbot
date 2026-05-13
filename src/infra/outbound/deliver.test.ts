import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "../../auto-reply/chunk.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaCapabilityModule from "../../media/read-capability.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginHookRegistration } from "../../plugins/types.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../diagnostic-events.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn<(_hookName?: string) => boolean>(() => false),
    runMessageSending: vi.fn<(event: unknown, ctx: unknown) => Promise<unknown>>(
      async () => undefined,
    ),
    runMessageSent: vi.fn<(event: unknown, ctx: unknown) => Promise<void>>(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const queueMocks = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(async () => "mock-queue-id"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
  markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {}),
  markDeliveryPlatformSendAttemptStarted: vi.fn(async () => {}),
  withActiveDeliveryClaim: vi.fn<
    (
      entryId: string,
      fn: () => Promise<unknown>,
    ) => Promise<{ status: "claimed"; value: unknown } | { status: "claimed-by-other-owner" }>
  >(async (_entryId, fn) => ({ status: "claimed", value: await fn() })),
}));
const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../../config/sessions/transcript.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../config/sessions/transcript.runtime.js")
  >("../../config/sessions/transcript.runtime.js");
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../config/sessions/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/transcript.js")>(
    "../../config/sessions/transcript.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("./delivery-queue.js", () => ({
  enqueueDelivery: queueMocks.enqueueDelivery,
  ackDelivery: queueMocks.ackDelivery,
  failDelivery: queueMocks.failDelivery,
  markDeliveryPlatformOutcomeUnknown: queueMocks.markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted: queueMocks.markDeliveryPlatformSendAttemptStarted,
  withActiveDeliveryClaim: queueMocks.withActiveDeliveryClaim,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const makeLogger = () => ({
      warn: logMocks.warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => makeLogger()),
    });
    return makeLogger();
  },
}));

type DeliverModule = typeof import("./deliver.js");

let deliverOutboundPayloads: DeliverModule["deliverOutboundPayloads"];
let normalizeOutboundPayloads: DeliverModule["normalizeOutboundPayloads"];
let resolveOutboundDurableFinalDeliverySupport: DeliverModule["resolveOutboundDurableFinalDeliverySupport"];

const matrixChunkConfig: OpenClawConfig = {
  channels: { matrix: { textChunkLimit: 4000 } } as OpenClawConfig["channels"],
};

const expectedPreferredTmpRoot = resolvePreferredOpenClawTmpDir();

type DeliverOutboundArgs = Parameters<DeliverModule["deliverOutboundPayloads"]>[0];
type DeliverOutboundPayload = DeliverOutboundArgs["payloads"][number];
type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(deps: DeliverOutboundArgs["deps"]): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

function requireMockCall(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): unknown[] {
  const call = mockFn.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call;
}

function requireMatrixSendCall(sendMatrix: ReturnType<typeof vi.fn>, index = 0): unknown[] {
  return requireMockCall(sendMatrix as { mock: { calls: unknown[][] } }, "matrix send", index);
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

const matrixOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => (text === "<br>" || text === "<br><br>" ? "" : text),
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        gifPlayback,
      }),
    ),
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    gifPlayback,
  }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        accountId: accountId ?? undefined,
        gifPlayback,
      }),
    ),
};

async function deliverMatrixPayload(params: {
  sendMatrix: MatrixSendFn;
  payload: DeliverOutboundPayload;
  cfg?: OpenClawConfig;
}) {
  return deliverOutboundPayloads({
    cfg: params.cfg ?? matrixChunkConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [params.payload],
    deps: { matrix: params.sendMatrix },
  });
}

async function runChunkedMatrixDelivery(params?: {
  mirror?: Parameters<typeof deliverOutboundPayloads>[0]["mirror"];
}) {
  const sendMatrix = vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1", roomId: "!room:example" })
    .mockResolvedValueOnce({ messageId: "m2", roomId: "!room:example" });
  const cfg: OpenClawConfig = {
    channels: { matrix: { textChunkLimit: 2 } } as OpenClawConfig["channels"],
  };
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "abcd" }],
    deps: { matrix: sendMatrix },
    ...(params?.mirror ? { mirror: params.mirror } : {}),
  });
  return { sendMatrix, results };
}

async function deliverSingleMatrixForHookTest(params?: { sessionKey?: string }) {
  const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
  await deliverOutboundPayloads({
    cfg: matrixChunkConfig,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "hello" }],
    deps: { matrix: sendMatrix },
    ...(params?.sessionKey ? { session: { key: params.sessionKey } } : {}),
  });
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function runBestEffortPartialFailureDelivery(params?: { onError?: boolean }) {
  const sendMatrix = vi
    .fn()
    .mockRejectedValueOnce(new Error("fail"))
    .mockResolvedValueOnce({ messageId: "m2", roomId: "!room:example" });
  const onError = vi.fn();
  const cfg: OpenClawConfig = {};
  const results = await deliverOutboundPayloads({
    cfg,
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "a" }, { text: "b" }],
    deps: { matrix: sendMatrix },
    bestEffort: true,
    ...(params?.onError === false ? {} : { onError }),
  });
  return { sendMatrix, onError, results };
}

describe("deliverOutboundPayloads", () => {
  beforeAll(async () => {
    ({
      deliverOutboundPayloads,
      normalizeOutboundPayloads,
      resolveOutboundDurableFinalDeliverySupport,
    } = await import("./deliver.js"));
  });

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(defaultRegistry);
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSending.mockClear();
    hookMocks.runner.runMessageSending.mockResolvedValue(undefined);
    hookMocks.runner.runMessageSent.mockClear();
    hookMocks.runner.runMessageSent.mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    queueMocks.enqueueDelivery.mockClear();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.ackDelivery.mockClear();
    queueMocks.ackDelivery.mockResolvedValue(undefined);
    queueMocks.failDelivery.mockClear();
    queueMocks.failDelivery.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockClear();
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockClear();
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockResolvedValue(undefined);
    queueMocks.withActiveDeliveryClaim.mockClear();
    queueMocks.withActiveDeliveryClaim.mockImplementation(async (_entryId, fn) => ({
      status: "claimed",
      value: await fn(),
    }));
    logMocks.warn.mockClear();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(emptyRegistry);
  });

  it("reports unsupported durable final delivery when required capabilities are missing", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async () => ({ channel: "matrix", messageId: "m1" }),
              deliveryCapabilities: {
                durableFinal: {
                  text: true,
                },
              },
            },
          }),
        },
      ]),
    );

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          silent: true,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "capability_mismatch",
      capability: "silent",
    });
  });

  it("uses channel message adapter capabilities for durable final support", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "matrix", messageId: "outbound" }),
                deliveryCapabilities: {
                  durableFinal: {
                    text: true,
                  },
                },
              },
            }),
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  silent: true,
                },
              },
              send: {
                text: async () => ({
                  messageId: "message",
                  receipt: createMessageReceiptFromOutboundResults({
                    results: [{ channel: "matrix", messageId: "message" }],
                    kind: "text",
                  }),
                }),
              },
            },
          },
        },
      ]),
    );

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          silent: true,
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("requires a real reconciler for required unknown-send recovery support", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "matrix", messageId: "outbound" }),
              },
            }),
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  reconcileUnknownSend: true,
                },
              },
              send: {
                text: async () => ({
                  messageId: "message",
                  receipt: createMessageReceiptFromOutboundResults({
                    results: [{ channel: "matrix", messageId: "message" }],
                    kind: "text",
                  }),
                }),
              },
            },
          },
        },
      ]),
    );

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          reconcileUnknownSend: true,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "capability_mismatch",
      capability: "reconcileUnknownSend",
    });
  });

  it("accepts required unknown-send recovery only when the adapter declares and implements it", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "matrix", messageId: "outbound" }),
              },
            }),
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  reconcileUnknownSend: true,
                },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
              },
              send: {
                text: async () => ({
                  messageId: "message",
                  receipt: createMessageReceiptFromOutboundResults({
                    results: [{ channel: "matrix", messageId: "message" }],
                    kind: "text",
                  }),
                }),
              },
            },
          },
        },
      ]),
    );

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          reconcileUnknownSend: true,
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("sends text through the channel message adapter when present", async () => {
    const messageSendText = vi.fn(async () => ({
      messageId: "message-adapter-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId: "message-adapter-1" }],
        kind: "text",
      }),
    }));
    const outboundSendText = vi.fn(async () => ({
      channel: "matrix" as const,
      messageId: "outbound-1",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "matrix",
              outbound: {
                deliveryMode: "direct",
                chunker: chunkText,
                sendText: outboundSendText,
              },
            }),
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                },
              },
              send: {
                text: messageSendText,
              },
            },
          },
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
    });

    const [[sendTextParams]] = messageSendText.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(sendTextParams?.to).toBe("!room:example");
    expect(sendTextParams?.text).toBe("hello");
    expect(outboundSendText).not.toHaveBeenCalled();
    expect(results[0]?.channel).toBe("matrix");
    expect(results[0]?.messageId).toBe("message-adapter-1");
    expect(results[0]?.receipt?.platformMessageIds).toEqual(["message-adapter-1"]);
  });

  it("runs message adapter send lifecycle after durable intent and before platform send", async () => {
    const order: string[] = [];
    queueMocks.enqueueDelivery.mockImplementationOnce(async () => {
      order.push("queue");
      return "queue-1";
    });
    queueMocks.ackDelivery.mockImplementationOnce(async () => {
      order.push("ack");
    });
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockImplementationOnce(async () => {
      order.push("mark-started");
    });
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockImplementationOnce(async () => {
      order.push("mark-unknown");
    });
    const messageSendText = vi.fn(async () => {
      order.push("send");
      return {
        messageId: "message-adapter-1",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId: "message-adapter-1" }],
          kind: "text",
        }),
      };
    });
    const beforeSendAttempt = vi.fn(() => {
      order.push("before");
      return "pending-1";
    });
    const afterSendSuccess = vi.fn(
      (ctx: { attemptToken?: unknown; result: { messageId?: string } }) => {
        order.push(`after:${String(ctx.attemptToken)}:${ctx.result.messageId ?? ""}`);
      },
    );
    const afterCommit = vi.fn((ctx: { attemptToken?: unknown; result: { messageId?: string } }) => {
      order.push(`commit:${String(ctx.attemptToken)}:${ctx.result.messageId ?? ""}`);
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  afterSendSuccess: true,
                  afterCommit: true,
                },
              },
              send: {
                lifecycle: {
                  beforeSendAttempt,
                  afterSendSuccess,
                  afterCommit,
                },
                text: messageSendText,
              },
            },
          },
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      queuePolicy: "required",
    });

    expect(order).toEqual([
      "queue",
      "before",
      "mark-started",
      "send",
      "after:pending-1:message-adapter-1",
      "mark-unknown",
      "ack",
      "commit:pending-1:message-adapter-1",
    ]);
    const [[beforeParams]] = beforeSendAttempt.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(beforeParams?.kind).toBe("text");
    expect(beforeParams?.to).toBe("!room:example");
    expect(beforeParams?.text).toBe("hello");
    const [[successParams]] = afterSendSuccess.mock.calls as unknown as Array<
      [Record<string, unknown> & { result?: { messageId?: string } }]
    >;
    expect(successParams?.kind).toBe("text");
    expect(successParams?.attemptToken).toBe("pending-1");
    expect(successParams?.result?.messageId).toBe("message-adapter-1");
    const [[commitParams]] = afterCommit.mock.calls as unknown as Array<
      [Record<string, unknown> & { result?: { messageId?: string } }]
    >;
    expect(commitParams?.kind).toBe("text");
    expect(commitParams?.attemptToken).toBe("pending-1");
    expect(commitParams?.result?.messageId).toBe("message-adapter-1");
    expect(results[0]?.channel).toBe("matrix");
    expect(results[0]?.messageId).toBe("message-adapter-1");
  });

  it("does not mark queued delivery as unknown when hooks cancel before platform send", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({
      cancel: true,
      content: "blocked",
    });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    });

    expect(results).toStrictEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformSendAttemptStarted).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
  });

  it("runs message adapter failure cleanup for failed sends with pending attempt tokens", async () => {
    const messageSendText = vi.fn(async () => {
      throw new Error("native send failed");
    });
    const afterSendFailure = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  afterSendSuccess: true,
                },
              },
              send: {
                lifecycle: {
                  beforeSendAttempt: () => "pending-2",
                  afterSendFailure,
                },
                text: messageSendText,
              },
            },
          },
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        queuePolicy: "required",
      }),
    ).rejects.toThrow("native send failed");

    const [[failureParams]] = afterSendFailure.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(failureParams?.kind).toBe("text");
    expect(failureParams?.attemptToken).toBe("pending-2");
    expect(failureParams?.error).toBeInstanceOf(Error);
    const failDeliveryCall = requireMockCall(queueMocks.failDelivery, "failDelivery");
    expect(failDeliveryCall[0]).toBe("mock-queue-id");
    expect(String(failDeliveryCall[1])).toContain("native send failed");
  });

  it("preserves native send errors when failure cleanup throws", async () => {
    const messageSendText = vi.fn(async () => {
      throw new Error("native send failed");
    });
    const afterSendFailure = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  afterSendSuccess: true,
                },
              },
              send: {
                lifecycle: {
                  beforeSendAttempt: () => "pending-2",
                  afterSendFailure,
                },
                text: messageSendText,
              },
            },
          },
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        queuePolicy: "required",
      }),
    ).rejects.toThrow("native send failed");

    const [[failureParams]] = afterSendFailure.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    expect(failureParams?.kind).toBe("text");
    expect(failureParams?.attemptToken).toBe("pending-2");
    expect(failureParams?.error).toBeInstanceOf(Error);
    const failDeliveryCall = requireMockCall(queueMocks.failDelivery, "failDelivery");
    expect(failDeliveryCall[0]).toBe("mock-queue-id");
    expect(String(failDeliveryCall[1])).toContain("native send failed");
  });

  it("preserves successful sends when the success hook throws", async () => {
    const afterSendFailure = vi.fn();
    const afterCommit = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  afterSendSuccess: true,
                  afterCommit: true,
                },
              },
              send: {
                lifecycle: {
                  afterSendSuccess: async () => {
                    throw new Error("success hook failed");
                  },
                  afterSendFailure,
                  afterCommit,
                },
                text: async () => ({
                  messageId: "message-adapter-1",
                  receipt: createMessageReceiptFromOutboundResults({
                    results: [{ channel: "matrix", messageId: "message-adapter-1" }],
                    kind: "text",
                  }),
                }),
              },
            },
          },
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      queuePolicy: "required",
    });

    expect(results[0]?.channel).toBe("matrix");
    expect(results[0]?.messageId).toBe("message-adapter-1");
    expect(afterSendFailure).not.toHaveBeenCalled();
    const [[commitParams]] = afterCommit.mock.calls as unknown as Array<
      [Record<string, unknown> & { result?: { messageId?: string } }]
    >;
    expect(commitParams?.kind).toBe("text");
    expect(commitParams?.result?.messageId).toBe("message-adapter-1");
    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("requires durable queue writes when requested", async () => {
    queueMocks.enqueueDelivery.mockRejectedValueOnce(new Error("queue offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("queue offline");

    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("falls back to direct send when best-effort queue writes fail", async () => {
    queueMocks.enqueueDelivery.mockRejectedValueOnce(new Error("queue offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "best_effort",
    });
    expect(results[0]?.messageId).toBe("m1");

    expect(sendMatrix).toHaveBeenCalled();
  });

  it("runs afterCommit hooks after best-effort queue fallback direct sends", async () => {
    queueMocks.enqueueDelivery.mockRejectedValueOnce(new Error("queue offline"));
    const afterCommit = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: {
                capabilities: {
                  text: true,
                  afterCommit: true,
                },
              },
              send: {
                lifecycle: {
                  afterCommit,
                },
                text: async () => ({
                  messageId: "message-adapter-1",
                  receipt: createMessageReceiptFromOutboundResults({
                    results: [{ channel: "matrix", messageId: "message-adapter-1" }],
                    kind: "text",
                  }),
                }),
              },
            },
          },
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      queuePolicy: "best_effort",
    });

    const [[commitParams]] = afterCommit.mock.calls as unknown as Array<
      [Record<string, unknown> & { result?: { messageId?: string } }]
    >;
    expect(commitParams?.kind).toBe("text");
    expect(commitParams?.result?.messageId).toBe("message-adapter-1");
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
  });

  it("requires the platform-send attempt marker before required durable platform I/O", async () => {
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockRejectedValueOnce(
      new Error("marker offline"),
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("marker offline");

    expect(queueMocks.markDeliveryPlatformSendAttemptStarted).toHaveBeenCalledWith("mock-queue-id");
    expect(sendMatrix).not.toHaveBeenCalled();
    const failDeliveryCall = requireMockCall(queueMocks.failDelivery, "failDelivery");
    expect(failDeliveryCall[0]).toBe("mock-queue-id");
    expect(String(failDeliveryCall[1])).toContain("marker offline");
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
  });

  it("fails required delivery when the post-send unknown marker cannot be written", async () => {
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockRejectedValueOnce(
      new Error("unknown marker offline"),
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("unknown marker offline");

    expect(sendMatrix).toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("fails required delivery when queue ack fails after platform send", async () => {
    queueMocks.ackDelivery.mockRejectedValueOnce(new Error("ack offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ack offline");

    expect(sendMatrix).toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("emits bounded delivery diagnostics for successful outbound sends", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    try {
      await deliverOutboundPayloads({
        cfg: matrixChunkConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "secret delivery body" }],
        deps: { matrix: sendMatrix },
        session: { key: "session-1" },
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const deliveryEvents = events.filter((event) =>
      event.type.startsWith("message.delivery."),
    ) as Array<Record<string, unknown>>;
    expect(deliveryEvents).toHaveLength(2);
    expect(deliveryEvents[0]?.type).toBe("message.delivery.started");
    expect(deliveryEvents[0]?.channel).toBe("matrix");
    expect(deliveryEvents[0]?.deliveryKind).toBe("text");
    expect(deliveryEvents[0]?.sessionKey).toBe("session-1");
    expect(deliveryEvents[1]?.type).toBe("message.delivery.completed");
    expect(deliveryEvents[1]?.channel).toBe("matrix");
    expect(deliveryEvents[1]?.deliveryKind).toBe("text");
    expect(typeof deliveryEvents[1]?.durationMs).toBe("number");
    expect(deliveryEvents[1]?.resultCount).toBe(1);
    expect(deliveryEvents[1]?.sessionKey).toBe("session-1");
    expect(JSON.stringify(deliveryEvents)).not.toContain("secret delivery body");
    expect(JSON.stringify(deliveryEvents)).not.toContain("!room:example");
  });

  it("emits bounded delivery diagnostics for outbound send failures", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event));
    const sendMatrix = vi
      .fn()
      .mockRejectedValue(new TypeError("secret delivery body could not send"));

    try {
      await deliverOutboundPayloads({
        cfg: matrixChunkConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "secret delivery body" }],
        deps: { matrix: sendMatrix },
        bestEffort: true,
        session: { key: "session-1" },
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const errorEvent = events.find((event) => event.type === "message.delivery.error") as
      | Record<string, unknown>
      | undefined;
    expect(errorEvent?.type).toBe("message.delivery.error");
    expect(errorEvent?.channel).toBe("matrix");
    expect(errorEvent?.deliveryKind).toBe("text");
    expect(typeof errorEvent?.durationMs).toBe("number");
    expect(errorEvent?.errorCategory).toBe("TypeError");
    expect(errorEvent?.sessionKey).toBe("session-1");
    expect(
      JSON.stringify(events.filter((event) => event.type.startsWith("message.delivery."))),
    ).not.toContain("secret delivery body");
  });

  it("keeps requester session channel authoritative for delivery media policy", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "attacker",
      },
    });

    const [mediaAccessOptions] = requireMockCall(resolveMediaAccessSpy, "media access") as [
      {
        messageProvider?: unknown;
        requesterSenderId?: unknown;
        sessionKey?: unknown;
      },
    ];
    expect(mediaAccessOptions?.sessionKey).toBe("agent:main:matrix:room:ops");
    expect(mediaAccessOptions?.messageProvider).toBeUndefined();
    expect(mediaAccessOptions?.requesterSenderId).toBe("attacker");
    resolveMediaAccessSpy.mockRestore();
  });

  it("forwards all sender fields to media access for non-id policy matching", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m2", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "id:matrix:123",
        requesterSenderName: "Alice",
        requesterSenderUsername: "alice_u",
        requesterSenderE164: "+15551234567",
      },
    });

    const [mediaAccessOptions] = requireMockCall(resolveMediaAccessSpy, "media access") as [
      {
        requesterSenderE164?: unknown;
        requesterSenderId?: unknown;
        requesterSenderName?: unknown;
        requesterSenderUsername?: unknown;
      },
    ];
    expect(mediaAccessOptions?.requesterSenderId).toBe("id:matrix:123");
    expect(mediaAccessOptions?.requesterSenderName).toBe("Alice");
    expect(mediaAccessOptions?.requesterSenderUsername).toBe("alice_u");
    expect(mediaAccessOptions?.requesterSenderE164).toBe("+15551234567");
    resolveMediaAccessSpy.mockRestore();
  });

  it("uses requester account from session for delivery media policy", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m3", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      accountId: "destination-account",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterAccountId: "source-account",
        requesterSenderId: "attacker",
      },
    });

    const [mediaAccessOptions] = requireMockCall(resolveMediaAccessSpy, "media access") as [
      {
        accountId?: unknown;
        requesterSenderId?: unknown;
        sessionKey?: unknown;
      },
    ];
    expect(mediaAccessOptions?.sessionKey).toBe("agent:main:matrix:room:ops");
    expect(mediaAccessOptions?.accountId).toBe("source-account");
    expect(mediaAccessOptions?.requesterSenderId).toBe("attacker");
    resolveMediaAccessSpy.mockRestore();
  });

  it("skips media access policy for text-only delivery", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m4", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "attacker",
      },
    });

    expect(resolveMediaAccessSpy).not.toHaveBeenCalled();
    resolveMediaAccessSpy.mockRestore();
  });

  it("chunks direct adapter text and preserves delivery overrides across sends", async () => {
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              textChunkLimit: 2,
              chunker: (text, limit) => {
                const chunks: string[] = [];
                for (let i = 0; i < text.length; i += limit) {
                  chunks.push(text.slice(i, i + limit));
                }
                return chunks;
              },
              sendText,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: { channels: { matrix: { textChunkLimit: 2 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      accountId: "default",
      payloads: [{ text: "abcd", replyToId: "777" }],
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    for (const call of sendText.mock.calls) {
      expect(call[0]?.accountId).toBe("default");
      expect(call[0]?.replyToId).toBe("777");
    }
    expect(results.map((entry) => entry.messageId)).toEqual(["ab", "cd"]);
  });

  it("uses replyToId only on the first low-level send for single-use reply modes", async () => {
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              textChunkLimit: 2,
              chunker: (text, limit) => {
                const chunks: string[] = [];
                for (let i = 0; i < text.length; i += limit) {
                  chunks.push(text.slice(i, i + limit));
                }
                return chunks;
              },
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: { textChunkLimit: 2 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "abcd" }],
      replyToId: "777",
      replyToMode: "first",
    });

    expect(sendText.mock.calls.map((call) => call[0]?.replyToId)).toEqual(["777", undefined]);
  });

  it("suppresses fallback replyToId when replyToMode is off but preserves explicit payload replies", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "fallback" }, { text: "explicit", replyToId: "payload-reply" }],
      replyToId: "fallback-reply",
      replyToMode: "off",
    });

    expect(sendText.mock.calls.map((call) => call[0]?.replyToId)).toEqual([
      undefined,
      "payload-reply",
    ]);
    expect(
      hookMocks.runner.runMessageSending.mock.calls.map(
        ([event]) => (event as { replyToId?: string }).replyToId,
      ),
    ).toEqual([undefined, "payload-reply"]);
  });

  it("does not let explicit payload replies consume the implicit single-use reply slot", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "explicit", replyToId: "payload-reply" }, { text: "fallback" }],
      replyToId: "fallback-reply",
      replyToMode: "first",
    });

    expect(sendText.mock.calls.map((call) => call[0]?.replyToId)).toEqual([
      "payload-reply",
      "fallback-reply",
    ]);
    expect(
      hookMocks.runner.runMessageSending.mock.calls.map(
        ([event]) => (event as { replyToId?: string }).replyToId,
      ),
    ).toEqual(["payload-reply", "fallback-reply"]);
  });

  it("skips text-only payloads blanked by message_sending hooks", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValue({ content: "   " });
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "should-not-send",
      roomId: "!room",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "redact me" }],
    });

    expect(results).toStrictEqual([]);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("keeps payload outcome indexes tied to original input payload positions", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({
      messageId: "visible",
      roomId: "!room:example",
    });
    const payloadOutcomes: unknown[] = [];

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "NO_REPLY" }, { text: "visible reply" }],
      deps: { matrix: sendMatrix },
      onPayloadDeliveryOutcome: (outcome) => {
        payloadOutcomes.push(outcome);
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.channel).toBe("matrix");
    expect(results[0]?.messageId).toBe("visible");
    expect(payloadOutcomes).toHaveLength(1);
    const payloadOutcome = payloadOutcomes[0] as { index?: unknown; status?: unknown } | undefined;
    expect(payloadOutcome?.index).toBe(1);
    expect(payloadOutcome?.status).toBe("sent");
  });

  it("strips internal runtime scaffolding added by message_sending hooks before delivery", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValue({
      content:
        "<previous_response>null</previous_response><system-reminder>hidden</system-reminder>visible",
    });
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "clean",
      roomId: "!room",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "original" }],
    });

    expect(requireMockCallArg(sendText, "sendText").text).toBe("visible");
  });

  it("strips internal runtime scaffolding before adapter payload normalization copies text", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValue({
      content: "<previous_response>null</previous_response>visible",
    });
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "clean",
      roomId: "!room",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              normalizePayload: ({ payload }) => ({
                ...payload,
                channelData: { copiedText: payload.text },
              }),
              sendText: vi.fn(),
              sendMedia: vi.fn(),
              sendPayload,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "original" }],
    });

    const deliveredPayload = requireMockCallArg(sendPayload, "sendPayload").payload as
      | { channelData?: unknown; text?: unknown }
      | undefined;
    expect(deliveredPayload?.text).toBe("visible");
    expect(deliveredPayload?.channelData).toStrictEqual({ copiedText: "visible" });
  });

  it("passes delivery config and account context to adapter payload normalization", async () => {
    const normalizePayload = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { normalized: true },
    }));
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "context",
      roomId: "!room",
    });
    const cfg = { channels: { matrix: { enabled: true } } } as unknown as OpenClawConfig;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              normalizePayload,
              sendText: vi.fn(),
              sendMedia: vi.fn(),
              sendPayload,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room",
      accountId: "workspace-a",
      payloads: [{ text: "visible" }],
    });

    const normalizeParams = requireMockCallArg(normalizePayload, "normalizePayload");
    expect(normalizeParams.accountId).toBe("workspace-a");
    expect(normalizeParams.cfg).toBe(cfg);
    expect((normalizeParams.payload as { text?: unknown }).text).toBe("visible");
    const sendParams = requireMockCallArg(sendPayload, "sendPayload");
    expect((sendParams.payload as { channelData?: unknown }).channelData).toEqual({
      normalized: true,
    });
  });

  it("strips internal runtime scaffolding copied into rendered and normalized nested payloads", async () => {
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "clean-nested",
      roomId: "!room",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              renderPresentation: ({ payload }) => ({
                ...payload,
                channelData: {
                  renderedText: payload.text,
                  renderedBlocks: [{ text: payload.text }],
                },
              }),
              normalizePayload: ({ payload }) => {
                const text = payload.text ?? "";
                return {
                  ...payload,
                  channelData: {
                    ...payload.channelData,
                    normalizedText: text,
                  },
                  interactive: {
                    blocks: [{ type: "text", text }],
                  },
                };
              },
              sendText: vi.fn(),
              sendMedia: vi.fn(),
              sendPayload,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [
        {
          text: "<previous_response>null</previous_response>visible",
          presentation: {
            title: "Title",
            blocks: [],
          },
        },
      ],
    });

    const deliveredPayload = requireMockCallArg(sendPayload, "sendPayload").payload as
      | { channelData?: unknown; interactive?: unknown; text?: unknown }
      | undefined;
    expect(JSON.stringify(deliveredPayload)).not.toContain("previous_response");
    expect(deliveredPayload?.text).toBe("visible");
    expect(deliveredPayload?.channelData).toStrictEqual({
      renderedText: "visible",
      renderedBlocks: [{ text: "visible" }],
      normalizedText: "visible",
    });
    expect(deliveredPayload?.interactive).toStrictEqual({
      blocks: [{ type: "text", text: "visible" }],
    });
  });

  it("runs adapter after-delivery hooks with the payload delivery results", async () => {
    const afterDeliverPayload = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ text }) => ({
                channel: "matrix" as const,
                messageId: text,
              }),
              afterDeliverPayload,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "hello" }],
    });

    const afterDeliveryOptions = requireMockCallArg(afterDeliverPayload, "afterDeliverPayload") as
      | {
          payload?: { text?: unknown };
          results?: unknown;
          target?: { channel?: unknown; to?: unknown };
        }
      | undefined;
    expect(afterDeliveryOptions?.target?.channel).toBe("matrix");
    expect(afterDeliveryOptions?.target?.to).toBe("!room");
    expect(afterDeliveryOptions?.payload?.text).toBe("hello");
    expect(afterDeliveryOptions?.results).toStrictEqual([
      { channel: "matrix", messageId: "hello" },
    ]);
  });

  it("uses adapter-provided formatted senders and scoped media roots when available", async () => {
    const sendText = vi.fn(async ({ text }: { text: string }) => ({
      channel: "line" as const,
      messageId: `fallback:${text}`,
    }));
    const sendMedia = vi.fn(async ({ text }: { text: string }) => ({
      channel: "line" as const,
      messageId: `media:${text}`,
    }));
    const sendFormattedText = vi.fn(async ({ text }: { text: string }) => [
      { channel: "line" as const, messageId: `fmt:${text}:1` },
      { channel: "line" as const, messageId: `fmt:${text}:2` },
    ]);
    const sendFormattedMedia = vi.fn(
      async ({ text }: { text: string; mediaLocalRoots?: readonly string[] }) => ({
        channel: "line" as const,
        messageId: `fmt-media:${text}`,
      }),
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: {
              deliveryMode: "direct",
              sendText,
              sendMedia,
              sendFormattedText,
              sendFormattedMedia,
            },
          }),
        },
      ]),
    );

    const textResults = await deliverOutboundPayloads({
      cfg: { channels: { line: {} } } as OpenClawConfig,
      channel: "line",
      to: "U123",
      accountId: "default",
      payloads: [{ text: "hello **boss**" }],
    });

    expect(sendFormattedText).toHaveBeenCalledTimes(1);
    const formattedTextOptions = requireMockCallArg(sendFormattedText, "sendFormattedText") as
      | { accountId?: unknown; text?: unknown; to?: unknown }
      | undefined;
    expect(formattedTextOptions?.to).toBe("U123");
    expect(formattedTextOptions?.text).toBe("hello **boss**");
    expect(formattedTextOptions?.accountId).toBe("default");
    expect(sendText).not.toHaveBeenCalled();
    expect(textResults.map((entry) => entry.messageId)).toEqual([
      "fmt:hello **boss**:1",
      "fmt:hello **boss**:2",
    ]);

    const cfg = { channels: { line: {} } } as OpenClawConfig;
    await deliverOutboundPayloads({
      cfg,
      channel: "line",
      to: "U123",
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/f.png" }],
      session: { agentId: "work" },
    });

    expect(sendFormattedMedia).toHaveBeenCalledTimes(1);
    const sendFormattedMediaCall = requireMockCallArg(sendFormattedMedia, "sendFormattedMedia") as
      | { mediaLocalRoots?: string[]; mediaUrl?: unknown; text?: unknown; to?: unknown }
      | undefined;
    expect(sendFormattedMediaCall?.to).toBe("U123");
    expect(sendFormattedMediaCall?.text).toBe("photo");
    expect(sendFormattedMediaCall?.mediaUrl).toBe("file:///tmp/f.png");
    expect(sendFormattedMediaCall?.mediaLocalRoots).toContain(expectedPreferredTmpRoot);
    expect(
      sendFormattedMediaCall?.mediaLocalRoots?.some((root) =>
        root.endsWith(path.join(".openclaw", "workspace-work")),
      ),
    ).toBe(true);
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("includes OpenClaw tmp root in plugin mediaLocalRoots", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("hi");
    const sendMatrixOptions = sendMatrixCall[2] as { mediaLocalRoots?: string[] } | undefined;
    expect(sendMatrixOptions?.mediaLocalRoots).toContain(expectedPreferredTmpRoot);
  });

  it("sends plugin media to an explicit target once instead of fanning out over allowFrom", async () => {
    const sendMedia = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "m1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({ channel: "matrix", messageId: "text-1" }),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {
        channels: {
          matrix: {
            allowFrom: ["111", "222", "333"],
          },
        } as OpenClawConfig["channels"],
      },
      channel: "matrix",
      to: "!explicit:example",
      payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
      skipQueue: true,
    });

    expect(sendMedia).toHaveBeenCalledTimes(1);
    const sendMediaOptions = (
      sendMedia.mock.calls as Array<
        [
          {
            accountId?: unknown;
            audioAsVoice?: unknown;
            mediaUrl?: unknown;
            text?: unknown;
            to?: unknown;
          },
        ]
      >
    )[0]?.[0];
    expect(sendMediaOptions?.to).toBe("!explicit:example");
    expect(sendMediaOptions?.text).toBe("HEARTBEAT_OK");
    expect(sendMediaOptions?.mediaUrl).toBe("https://example.com/img.png");
    expect(sendMediaOptions?.accountId).toBeUndefined();
  });

  it("forwards audioAsVoice through generic plugin media delivery", async () => {
    const sendMedia = vi.fn(async () => ({
      channel: "matrix" as const,
      messageId: "mx-1",
      roomId: "!room:example",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ to, text }) => ({
                channel: "matrix",
                messageId: `${to}:${text}`,
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
      channel: "matrix",
      to: "room:!room:example",
      payloads: [{ text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true }],
    });

    const sendMediaOptions = (
      sendMedia.mock.calls as unknown as Array<
        [{ audioAsVoice?: unknown; mediaUrl?: unknown; text?: unknown; to?: unknown }]
      >
    )[0]?.[0];
    expect(sendMediaOptions?.to).toBe("room:!room:example");
    expect(sendMediaOptions?.text).toBe("voice caption");
    expect(sendMediaOptions?.mediaUrl).toBe("file:///tmp/clip.mp3");
    expect(sendMediaOptions?.audioAsVoice).toBe(true);
  });

  it("exposes audio-only spokenText to hooks without rendering it as media caption", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runMessageSending.mockResolvedValue({
      content: "rewritten hidden transcript",
    });
    const sendMedia = vi.fn(async () => ({
      channel: "matrix" as const,
      messageId: "mx-voice",
      roomId: "!room:example",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
      channel: "matrix",
      to: "room:!room:example",
      payloads: [
        {
          mediaUrl: "file:///tmp/clip.opus",
          audioAsVoice: true,
          spokenText: "original hidden transcript",
        },
      ],
    });

    const sendingCall = requireMockCall(
      hookMocks.runner.runMessageSending,
      "message_sending hook",
    ) as [{ content?: unknown }, { channelId?: unknown }] | undefined;
    expect(sendingCall?.[0]?.content).toBe("original hidden transcript");
    expect(sendingCall?.[1]?.channelId).toBe("matrix");
    const sendMediaOptions = (
      sendMedia.mock.calls as unknown as Array<
        [{ audioAsVoice?: unknown; mediaUrl?: unknown; text?: unknown }]
      >
    )[0]?.[0];
    expect(sendMediaOptions?.text).toBe("");
    expect(sendMediaOptions?.mediaUrl).toBe("file:///tmp/clip.opus");
    expect(sendMediaOptions?.audioAsVoice).toBe(true);
    const sentCall = requireMockCall(hookMocks.runner.runMessageSent, "message_sent hook") as
      | [{ content?: unknown; success?: unknown }, { channelId?: unknown }]
      | undefined;
    expect(sentCall?.[0]?.content).toBe("rewritten hidden transcript");
    expect(sentCall?.[0]?.success).toBe(true);
    expect(sentCall?.[1]?.channelId).toBe("matrix");
  });

  it("chunks plugin text and returns all results", async () => {
    const { sendMatrix, results } = await runChunkedMatrixDelivery();

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["m1", "m2"]);
  });

  it("respects newline chunk mode for plugin text", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const cfg: OpenClawConfig = {
      channels: {
        matrix: { textChunkLimit: 4000, chunkMode: "newline" },
      } as OpenClawConfig["channels"],
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Line one\n\nLine two" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    const firstChunkCall = requireMatrixSendCall(sendMatrix);
    expect(firstChunkCall?.[0]).toBe("!room:example");
    expect(firstChunkCall?.[1]).toBe("Line one");
    expect((firstChunkCall?.[2] as { cfg?: unknown } | undefined)?.cfg).toBe(cfg);
    const secondChunkCall = sendMatrix.mock.calls[1];
    expect(secondChunkCall?.[0]).toBe("!room:example");
    expect(secondChunkCall?.[1]).toBe("Line two");
    expect((secondChunkCall?.[2] as { cfg?: unknown } | undefined)?.cfg).toBe(cfg);
  });

  it("lets explicit formatting options override configured chunking", async () => {
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker: (text, limit) => {
                const chunks: string[] = [];
                for (let i = 0; i < text.length; i += limit) {
                  chunks.push(text.slice(i, i + limit));
                }
                return chunks;
              },
              textChunkLimit: 4000,
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: { textChunkLimit: 4000 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "abcd" }],
      formatting: { textLimit: 2, chunkMode: "length" },
    });

    expect(sendText.mock.calls.map((call) => call[0]?.text)).toEqual(["ab", "cd"]);
  });

  it("passes formatting options to adapter chunkers before consuming single-use replies", async () => {
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "!room",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker: (text, _limit, ctx) =>
                text.split("\n").reduce<string[]>((chunks, line) => {
                  const maxLines = ctx?.formatting?.maxLinesPerMessage;
                  if (maxLines === 1) {
                    chunks.push(line);
                    return chunks;
                  }
                  chunks[chunks.length - 1] = chunks.length
                    ? `${chunks[chunks.length - 1]}\n${line}`
                    : line;
                  return chunks;
                }, []),
              textChunkLimit: 4000,
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: { textChunkLimit: 4000 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "line one\nline two" }],
      replyToId: "reply-1",
      replyToMode: "first",
      formatting: { maxLinesPerMessage: 1 },
    });

    expect(sendText.mock.calls.map((call) => call[0]?.text)).toEqual(["line one", "line two"]);
    expect(sendText.mock.calls.map((call) => call[0]?.replyToId)).toEqual(["reply-1", undefined]);
  });

  it("drops text payloads after adapter sanitization removes all content", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const results = await deliverMatrixPayload({
      sendMatrix,
      payload: { text: "<br><br>" },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(results).toStrictEqual([]);
  });

  it("drops plugin HTML-only text payloads after sanitization", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "<br>" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(results).toStrictEqual([]);
  });

  it("preserves fenced blocks for markdown chunkers in newline mode", async () => {
    const chunker = vi.fn((text: string) => (text ? [text] : []));
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    const sendMedia = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker,
              chunkerMode: "markdown",
              textChunkLimit: 4000,
              sendText,
              sendMedia,
            },
          }),
        },
      ]),
    );

    const cfg: OpenClawConfig = {
      channels: { matrix: { textChunkLimit: 4000, chunkMode: "newline" } },
    };
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room",
      payloads: [{ text }],
    });

    expect(chunker).toHaveBeenCalledTimes(1);
    expect(chunker).toHaveBeenNthCalledWith(1, text, 4000);
  });

  it("passes formatting overrides for pre-rendered chunker output", async () => {
    const chunker = vi.fn(() => ["<b>bold</b>"]);
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker,
              chunkerMode: "markdown",
              chunkedTextFormatting: { parseMode: "HTML" },
              textChunkLimit: 4000,
              sendText,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "**bold**" }],
    });

    expect(chunker).toHaveBeenCalledWith("**bold**", 4000);
    const sendTextParams = requireMockCallArg(sendText, "sendText");
    expect(sendTextParams.text).toBe("<b>bold</b>");
    expect(sendTextParams.formatting).toEqual({ parseMode: "HTML" });
  });

  it("passes config through for plugin media sends", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForTest }),
        },
      ]),
    );
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello", mediaUrls: ["https://example.com/a.png"] }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    const sendMatrixOptions = sendMatrixCall[2] as
      | { cfg?: unknown; mediaUrl?: unknown }
      | undefined;
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("hello");
    expect(sendMatrixOptions?.cfg).toBe(cfg);
    expect(sendMatrixOptions?.mediaUrl).toBe("https://example.com/a.png");
  });

  it("keeps markdown images as text for channels that do not opt in", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-text", roomId: "!room" });

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Tech: ![Node.js](https://img.shields.io/badge/Node.js-339933)" }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    const sendMatrixOptions = sendMatrixCall[2] as { mediaUrl?: unknown } | undefined;
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("Tech: ![Node.js](https://img.shields.io/badge/Node.js-339933)");
    expect(sendMatrixOptions?.mediaUrl).toBeUndefined();
  });

  it("extracts markdown images for channels that opt in", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { ...matrixOutboundForTest, extractMarkdownImages: true },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Chart ![chart](https://example.com/chart.png) now" }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    const sendMatrixOptions = sendMatrixCall[2] as { mediaUrl?: unknown } | undefined;
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("Chart now");
    expect(sendMatrixOptions?.mediaUrl).toBe("https://example.com/chart.png");
  });

  it("normalizes payloads and drops empty entries", () => {
    const normalized = normalizeOutboundPayloads([
      { text: "hi" },
      { text: "MEDIA:https://x.test/a.jpg" },
      { text: " ", mediaUrls: [] },
    ]);
    expect(normalized).toEqual([
      { text: "hi", mediaUrls: [] },
      { text: "", mediaUrls: ["https://x.test/a.jpg"] },
    ]);
  });

  it("continues on errors when bestEffort is enabled", async () => {
    const { sendMatrix, onError, results } = await runBestEffortPartialFailureDelivery();

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "matrix", messageId: "m2", roomId: "!room:example" }]);
  });

  it("emits internal message:sent hook with success=true for chunked payload delivery", async () => {
    const { sendMatrix } = await runChunkedMatrixDelivery({
      mirror: {
        sessionKey: "agent:main:main",
        isGroup: true,
        groupId: "matrix:room:123",
      },
    });
    expect(sendMatrix).toHaveBeenCalledTimes(2);

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const createHookCall = requireMockCall(
      internalHookMocks.createInternalHookEvent,
      "create internal hook event",
    ) as
      | [
          unknown,
          unknown,
          unknown,
          {
            channelId?: unknown;
            content?: unknown;
            conversationId?: unknown;
            groupId?: unknown;
            isGroup?: unknown;
            messageId?: unknown;
            success?: unknown;
            to?: unknown;
          },
        ]
      | undefined;
    expect(createHookCall?.[0]).toBe("message");
    expect(createHookCall?.[1]).toBe("sent");
    expect(createHookCall?.[2]).toBe("agent:main:main");
    expect(createHookCall?.[3]?.to).toBe("!room:example");
    expect(createHookCall?.[3]?.success).toBe(true);
    expect(createHookCall?.[3]?.channelId).toBe("matrix");
    expect(createHookCall?.[3]?.conversationId).toBe("!room:example");
    expect(createHookCall?.[3]?.content).toBe("abcd");
    expect(createHookCall?.[3]?.messageId).toBe("m2");
    expect(createHookCall?.[3]?.isGroup).toBe(true);
    expect(createHookCall?.[3]?.groupId).toBe("matrix:room:123");
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("does not emit internal message:sent hook when neither mirror nor sessionKey is provided", async () => {
    await deliverSingleMatrixForHookTest();

    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("emits internal message:sent hook when sessionKey is provided without mirror", async () => {
    await deliverSingleMatrixForHookTest({ sessionKey: "agent:main:main" });

    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    const createHookCall = requireMockCall(
      internalHookMocks.createInternalHookEvent,
      "create internal hook event",
    ) as
      | [
          unknown,
          unknown,
          unknown,
          {
            channelId?: unknown;
            content?: unknown;
            conversationId?: unknown;
            messageId?: unknown;
            success?: unknown;
            to?: unknown;
          },
        ]
      | undefined;
    expect(createHookCall?.[0]).toBe("message");
    expect(createHookCall?.[1]).toBe("sent");
    expect(createHookCall?.[2]).toBe("agent:main:main");
    expect(createHookCall?.[3]?.to).toBe("!room:example");
    expect(createHookCall?.[3]?.success).toBe(true);
    expect(createHookCall?.[3]?.channelId).toBe("matrix");
    expect(createHookCall?.[3]?.conversationId).toBe("!room:example");
    expect(createHookCall?.[3]?.content).toBe("hello");
    expect(createHookCall?.[3]?.messageId).toBe("m1");
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledTimes(1);
  });

  it("warns when session.agentId is set without a session key", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    hookMocks.runner.hasHooks.mockReturnValue(true);

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      session: { agentId: "agent-main" },
    });

    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toBe(
      "deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped",
    );
    const warnContext = warnCall[1] as
      | { agentId?: unknown; channel?: unknown; to?: unknown }
      | undefined;
    expect(warnContext?.channel).toBe("matrix");
    expect(warnContext?.to).toBe("!room:example");
    expect(warnContext?.agentId).toBe("agent-main");
  });

  it("calls failDelivery instead of ackDelivery on bestEffort partial failure", async () => {
    const { onError } = await runBestEffortPartialFailureDelivery();

    // onError was called for the first payload's failure.
    expect(onError).toHaveBeenCalledTimes(1);

    // Queue entry should NOT be acked — failDelivery should be called instead.
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
  });

  it("calls failDelivery instead of ackDelivery on bestEffort partial failure without onError", async () => {
    await runBestEffortPartialFailureDelivery({ onError: false });

    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
  });

  it("writes raw payloads to the queue before normalization", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-raw", roomId: "!room:example" });
    const rawPayloads: DeliverOutboundPayload[] = [
      { text: "NO_REPLY" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "caption\nMEDIA:https://x.test/a.png" },
      { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
    ];

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: rawPayloads,
      deps: { matrix: sendMatrix },
    });

    expect(queueMocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    const queuedDelivery = (
      queueMocks.enqueueDelivery.mock.calls as unknown as Array<
        [
          {
            payloads?: unknown;
            renderedBatchPlan?: {
              items?: Array<{
                index?: unknown;
                kinds?: unknown;
                mediaUrls?: unknown;
                text?: unknown;
              }>;
              mediaCount?: unknown;
              payloadCount?: unknown;
              textCount?: unknown;
            };
          },
        ]
      >
    )[0]?.[0];
    expect(queuedDelivery?.payloads).toStrictEqual([
      { text: "NO_REPLY" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "caption\nMEDIA:https://x.test/a.png" },
      { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
    ]);
    const renderedPlan = queuedDelivery?.renderedBatchPlan;
    expect(renderedPlan?.payloadCount).toBe(4);
    expect(renderedPlan?.textCount).toBe(4);
    expect(renderedPlan?.mediaCount).toBe(1);
    const noReplyMediaItem = renderedPlan?.items?.find((item) => item.index === 3);
    expect(noReplyMediaItem?.kinds).toStrictEqual(["text", "media"]);
    expect(noReplyMediaItem?.text).toBe("NO_REPLY");
    expect(noReplyMediaItem?.mediaUrls).toStrictEqual(["https://x.test/b.png"]);
  });

  it("strips internal runtime scaffolding before queue persistence", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValue({ messageId: "m-internal", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [
        {
          text: [
            "visible",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "OpenClaw runtime context (internal):",
            "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
            "raw child output",
            "<<<END_UNTRUSTED_CHILD_RESULT>>>",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            "after",
          ].join("\n"),
          channelData: {
            internal: [
              "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
              "internal metadata",
              "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            ].join("\n"),
          },
        },
      ],
      deps: { matrix: sendMatrix },
    });

    const queuedDelivery = (
      queueMocks.enqueueDelivery.mock.calls as unknown as Array<
        [
          {
            payloads?: unknown;
            renderedBatchPlan?: {
              items?: Array<{ text?: unknown }>;
              payloadCount?: unknown;
              textCount?: unknown;
            };
          },
        ]
      >
    )[0]?.[0];
    expect(queuedDelivery?.payloads).toStrictEqual([
      {
        text: "visible\nafter",
        channelData: {
          internal: "",
        },
      },
    ]);
    expect(queuedDelivery?.renderedBatchPlan?.payloadCount).toBe(1);
    expect(queuedDelivery?.renderedBatchPlan?.textCount).toBe(1);
    expect(queuedDelivery?.renderedBatchPlan?.items?.[0]?.text).toBe("visible\nafter");
  });

  it("persists rendered batch plans with queued deliveries", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-plan", roomId: "!room:example" });
    const renderedBatchPlan = {
      payloadCount: 2,
      textCount: 1,
      mediaCount: 1,
      voiceCount: 0,
      presentationCount: 0,
      interactiveCount: 0,
      channelDataCount: 0,
      items: [
        { index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] },
        { index: 1, kinds: ["media"] as const, mediaUrls: ["file:///tmp/a.png"] },
      ],
    };

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }, { mediaUrl: "file:///tmp/a.png" }],
      deps: { matrix: sendMatrix },
      renderedBatchPlan,
    });

    const queuedDelivery = (
      queueMocks.enqueueDelivery.mock.calls as unknown as Array<[{ renderedBatchPlan?: unknown }]>
    )[0]?.[0];
    expect(queuedDelivery?.renderedBatchPlan).toBe(renderedBatchPlan);
  });

  it("applies silent-reply rewrite policy from the outbound session", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-silent", roomId: "!room" });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
        },
      },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "NO_REPLY" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:slash:!room",
        policyKey: "agent:main:matrix:direct:!room",
      },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    const deliveredText = requireMatrixSendCall(sendMatrix)[1];
    expect(deliveredText).toBe("No extra update from me.");
  });

  it("keeps allowed group silent replies silent during outbound delivery", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-silent", roomId: "!room" });

    await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "NO_REPLY" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:group:ops",
      },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("bails out without sending when a concurrent drain already claimed the queue entry", async () => {
    // Regression for openclaw/openclaw#70386: if a reconnect or startup drain
    // observes the newly enqueued entry and claims it before the live send
    // path claims it, the live path must not send. The drain already owns
    // ack/fail for that id; sending here would duplicate the outbound and
    // race queue cleanup.
    queueMocks.withActiveDeliveryClaim.mockResolvedValueOnce({
      status: "claimed-by-other-owner",
    });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
    });

    expect(results).toStrictEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("acks the queue entry when delivery is aborted", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const abortController = new AbortController();
    abortController.abort();
    const cfg: OpenClawConfig = {};

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "a" }],
        deps: { matrix: sendMatrix },
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("Operation aborted");

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("passes normalized payload to onError", async () => {
    const sendMatrix = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { matrix: sendMatrix },
      bestEffort: true,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, failedPayload] = requireMockCall(onError, "onError");
    expect(error).toBeInstanceOf(Error);
    expect((failedPayload as { text?: unknown } | undefined)?.text).toBe("hi");
    expect((failedPayload as { mediaUrls?: unknown } | undefined)?.mediaUrls).toStrictEqual([
      "https://x.test/a.jpg",
    ]);
  });

  it("mirrors delivered output when mirror options are provided", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ text }) => ({ channel: "line", messageId: text }),
              sendMedia: async ({ text }) => ({ channel: "line", messageId: text }),
            },
          }),
        },
      ]),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockClear();

    const cfg = { channels: { line: {} } } as OpenClawConfig;
    await deliverOutboundPayloads({
      cfg,
      channel: "line",
      to: "U123",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/files/report.pdf?sig=1" }],
      mirror: {
        sessionKey: "agent:main:main",
        text: "caption",
        mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
        idempotencyKey: "idem-deliver-1",
      },
    });

    const appendOptions = (
      mocks.appendAssistantMessageToSessionTranscript.mock.calls as unknown as Array<
        [{ config?: unknown; idempotencyKey?: unknown; text?: unknown }]
      >
    )[0]?.[0];
    expect(appendOptions?.text).toBe("report.pdf");
    expect(appendOptions?.idempotencyKey).toBe("idem-deliver-1");
    expect(appendOptions?.config).toBe(cfg);
  });

  it("emits message_sent success for text-only deliveries", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
    });

    const sentCall = requireMockCall(hookMocks.runner.runMessageSent, "message_sent hook") as
      | [{ content?: unknown; success?: unknown; to?: unknown }, { channelId?: unknown }]
      | undefined;
    expect(sentCall?.[0]?.to).toBe("!room:example");
    expect(sentCall?.[0]?.content).toBe("hello");
    expect(sentCall?.[0]?.success).toBe(true);
    expect(sentCall?.[1]?.channelId).toBe("matrix");
  });

  it("short-circuits lower-priority message_sending hooks after cancel=true", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const high = vi.fn().mockResolvedValue({ cancel: true, content: "blocked" });
    const low = vi.fn().mockResolvedValue({ cancel: false, content: "override" });
    addTestHook({
      registry: hookRegistry,
      pluginId: "high",
      hookName: "message_sending",
      handler: high as PluginHookRegistration["handler"],
      priority: 100,
    });
    addTestHook({
      registry: hookRegistry,
      pluginId: "low",
      hookName: "message_sending",
      handler: low as PluginHookRegistration["handler"],
      priority: 0,
    });
    const realRunner = createHookRunner(hookRegistry);
    hookMocks.runner.hasHooks.mockImplementation((hookName?: string) =>
      realRunner.hasHooks((hookName ?? "") as never),
    );
    hookMocks.runner.runMessageSending.mockImplementation((event, ctx) =>
      realRunner.runMessageSending(event as never, ctx as never),
    );

    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
    });

    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledTimes(1);
    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
  });

  it("keeps text-only error payloads on the normal text path by default", async () => {
    const sendPayload = vi.fn();
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "provider exploded", isError: true }],
    });

    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
    expect(requireMockCallArg(sendText, "sendText").text).toBe("provider exploded");
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("routes text-only error payloads through sendPayload when the adapter opts in", async () => {
    const sendPayload = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const sendText = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendPayload,
              sendText,
              sendTextOnlyErrorPayloads: true,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "provider exploded", isError: true }],
    });

    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
    const sendPayloadOptions = requireMockCallArg(sendPayload, "sendPayload") as
      | { payload?: { isError?: unknown; text?: unknown }; text?: unknown }
      | undefined;
    expect(sendPayloadOptions?.text).toBe("provider exploded");
    expect(sendPayloadOptions?.payload?.text).toBe("provider exploded");
    expect(sendPayloadOptions?.payload?.isError).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not count no-op sendPayload results as delivered", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendPayload = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "" });
    const sendText = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendPayload,
              sendText,
              sendTextOnlyErrorPayloads: true,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "provider exploded", isError: true }],
      mirror: {
        sessionKey: "agent:main:main",
        agentId: "main",
        text: "provider exploded",
      },
    });

    expect(results).toStrictEqual([]);
    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("emits message_sent success for sendPayload deliveries", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendPayload = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "payload text", channelData: { mode: "custom" } }],
    });

    const sentCall = requireMockCall(hookMocks.runner.runMessageSent, "message_sent hook") as
      | [{ content?: unknown; success?: unknown; to?: unknown }, { channelId?: unknown }]
      | undefined;
    expect(sentCall?.[0]?.to).toBe("!room:1");
    expect(sentCall?.[0]?.content).toBe("payload text");
    expect(sentCall?.[0]?.success).toBe(true);
    expect(sentCall?.[1]?.channelId).toBe("matrix");
  });

  it("does not fail successful sends when optional delivery pinning fails", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const pinDeliveredMessage = vi.fn().mockRejectedValue(new Error("pin denied"));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, pinDeliveredMessage },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "hello", delivery: { pin: true } }],
    });

    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
    expect(pinDeliveredMessage).toHaveBeenCalledTimes(1);
    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toBe(
      "Delivery pin requested, but channel failed to pin delivered message.",
    );
    const warnContext = warnCall[1] as
      | { channel?: unknown; error?: unknown; messageId?: unknown }
      | undefined;
    expect(warnContext?.channel).toBe("matrix");
    expect(warnContext?.messageId).toBe("mx-1");
    expect(warnContext?.error).toBe("pin denied");
  });

  it("fails sends when required delivery pinning fails", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const pinDeliveredMessage = vi.fn().mockRejectedValue(new Error("pin denied"));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, pinDeliveredMessage },
          }),
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:1",
        payloads: [{ text: "hello", delivery: { pin: { enabled: true, required: true } } }],
      }),
    ).rejects.toThrow("pin denied");
  });

  it("pins the first delivered text chunk for chunked payloads", async () => {
    const sendText = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const pinDeliveredMessage = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker: chunkText,
              chunkerMode: "text",
              textChunkLimit: 2,
              sendText,
              pinDeliveredMessage,
            },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "abcd", delivery: { pin: true } }],
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    const pinOptions = (
      pinDeliveredMessage.mock.calls as unknown as Array<[{ messageId?: unknown }]>
    )[0]?.[0];
    expect(pinOptions?.messageId).toBe("mx-1");
  });

  it("pins the first delivered media message for multi-media payloads", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-text" });
    const sendMedia = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const pinDeliveredMessage = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText, sendMedia, pinDeliveredMessage },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          delivery: { pin: true },
        },
      ],
    });

    expect(sendMedia).toHaveBeenCalledTimes(2);
    const pinOptions = (
      pinDeliveredMessage.mock.calls as unknown as Array<[{ messageId?: unknown }]>
    )[0]?.[0];
    expect(pinOptions?.messageId).toBe("mx-1");
  });

  it("preserves channelData-only payloads with empty text for sendPayload channels", async () => {
    const sendPayload = vi.fn().mockResolvedValue({ channel: "line", messageId: "ln-1" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: " \n\t ", channelData: { mode: "flex" } }],
    });

    expect(sendPayload).toHaveBeenCalledTimes(1);
    const sendPayloadOptions = requireMockCallArg(sendPayload, "sendPayload") as
      | { payload?: { channelData?: unknown; text?: unknown } }
      | undefined;
    expect(sendPayloadOptions?.payload?.text).toBe("");
    expect(sendPayloadOptions?.payload?.channelData).toStrictEqual({ mode: "flex" });
    expect(results).toEqual([{ channel: "line", messageId: "ln-1" }]);
  });

  it("falls back to sendText when plugin outbound omits sendMedia", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/file.png" }],
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(requireMockCallArg(sendText, "sendText").text).toBe("caption");
    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toBe(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
    );
    const warnContext = warnCall[1] as { channel?: unknown; mediaCount?: unknown } | undefined;
    expect(warnContext?.channel).toBe("matrix");
    expect(warnContext?.mediaCount).toBe(1);
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
  });

  it("falls back to one sendText call for multi-media payloads when sendMedia is omitted", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-2" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
      ],
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(requireMockCallArg(sendText, "sendText").text).toBe("caption");
    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toBe(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
    );
    const warnContext = warnCall[1] as { channel?: unknown; mediaCount?: unknown } | undefined;
    expect(warnContext?.channel).toBe("matrix");
    expect(warnContext?.mediaCount).toBe(2);
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-2" }]);
  });

  it("fails media-only payloads when plugin outbound omits sendMedia", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-3" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:1",
        payloads: [{ text: "   ", mediaUrl: "https://example.com/file.png" }],
      }),
    ).rejects.toThrow(
      "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
    );

    expect(sendText).not.toHaveBeenCalled();
    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toBe(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
    );
    const warnContext = warnCall[1] as { channel?: unknown; mediaCount?: unknown } | undefined;
    expect(warnContext?.channel).toBe("matrix");
    expect(warnContext?.mediaCount).toBe(1);
    const sentCall = requireMockCall(hookMocks.runner.runMessageSent, "message_sent hook") as
      | [
          { content?: unknown; error?: unknown; success?: unknown; to?: unknown },
          { channelId?: unknown },
        ]
      | undefined;
    expect(sentCall?.[0]?.to).toBe("!room:1");
    expect(sentCall?.[0]?.content).toBe("");
    expect(sentCall?.[0]?.success).toBe(false);
    expect(sentCall?.[0]?.error).toBe(
      "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
    );
    expect(sentCall?.[1]?.channelId).toBe("matrix");
  });

  it("emits message_sent failure when delivery errors", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendMatrix = vi.fn().mockRejectedValue(new Error("downstream failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
      }),
    ).rejects.toThrow("downstream failed");

    const sentCall = requireMockCall(hookMocks.runner.runMessageSent, "message_sent hook") as
      | [
          { content?: unknown; error?: unknown; success?: unknown; to?: unknown },
          { channelId?: unknown },
        ]
      | undefined;
    expect(sentCall?.[0]?.to).toBe("!room:example");
    expect(sentCall?.[0]?.content).toBe("hi");
    expect(sentCall?.[0]?.success).toBe(false);
    expect(sentCall?.[0]?.error).toBe("downstream failed");
    expect(sentCall?.[1]?.channelId).toBe("matrix");
  });
});

const emptyRegistry = createTestRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "matrix",
    plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForTest }),
    source: "test",
  },
]);
