// Covers outbound delivery core: hooks, queue cleanup, durable capability
// checks, adapter sends, transcript mirroring, and payload outcomes.
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedMessageAuditEvent,
  resetMessageAuditEventsForTest,
  type TrustedMessageAuditEvent,
} from "../../audit/message-audit-events.js";
import { chunkText } from "../../auto-reply/chunk.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelMessageSendTextContext } from "../../channels/message/types.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionTranscriptAppendResult } from "../../config/sessions/transcript.js";
import * as mediaCapabilityModule from "../../media/read-capability.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginHookRegistration } from "../../plugins/types.js";
import {
  createChannelTestPluginBase,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../diagnostic-events.js";
import { retryAsync } from "../retry.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn<() => Promise<SessionTranscriptAppendResult>>(
    async () => ({ ok: true, sessionFile: "x", messageId: "m" }),
  ),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn<(_hookName?: string) => boolean>(() => false),
    runMessageSending: vi.fn<(event: unknown, ctx: unknown) => Promise<unknown>>(
      async () => undefined,
    ),
    runReplyPayloadSending: vi.fn<(event: unknown, ctx: unknown) => Promise<unknown>>(
      async (event) => ({ payload: (event as { payload?: unknown }).payload }),
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
  failDeliveryAfterPlatformSend: vi.fn(async () => {}),
  failDeliveryBeforePlatformSend: vi.fn(async () => {}),
  markDeliveryPlatformOutcomeUnknown: vi.fn(async () => {}),
  markDeliveryPlatformSendDispatched: vi.fn(async () => {}),
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
  failDeliveryAfterPlatformSend: queueMocks.failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend: queueMocks.failDeliveryBeforePlatformSend,
  markDeliveryPlatformOutcomeUnknown: queueMocks.markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched: queueMocks.markDeliveryPlatformSendDispatched,
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
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
    resetMessageAuditEventsForTest();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(defaultRegistry);
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSending.mockClear();
    hookMocks.runner.runMessageSending.mockResolvedValue(undefined);
    hookMocks.runner.runReplyPayloadSending.mockClear();
    hookMocks.runner.runReplyPayloadSending.mockImplementation(async (event) => ({
      payload: (event as { payload?: unknown }).payload,
    }));
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
    queueMocks.failDeliveryAfterPlatformSend.mockClear();
    queueMocks.failDeliveryAfterPlatformSend.mockResolvedValue(undefined);
    queueMocks.failDeliveryBeforePlatformSend.mockClear();
    queueMocks.failDeliveryBeforePlatformSend.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockClear();
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockClear();
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformSendDispatched.mockClear();
    queueMocks.markDeliveryPlatformSendDispatched.mockResolvedValue(undefined);
    queueMocks.withActiveDeliveryClaim.mockClear();
    queueMocks.withActiveDeliveryClaim.mockImplementation(async (_entryId, fn) => ({
      status: "claimed",
      value: await fn(),
    }));
    logMocks.warn.mockClear();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetMessageAuditEventsForTest();
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(emptyRegistry);
  });

  it("delivers through full active plugin when pinned setup channel has no sender", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const setupRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "setup",
        plugin: createChannelTestPluginBase({ id: "matrix" }),
      },
    ]);
    const runtimeRegistry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "runtime",
        plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForTest }),
      },
    ]);

    setActivePluginRegistry(setupRegistry);
    pinActivePluginChannelRegistry(setupRegistry);
    setActivePluginRegistry(runtimeRegistry);

    const results = await deliverOutboundPayloads({
      cfg: matrixChunkConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello from queue" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledWith("!room:example", "hello from queue", {
      cfg: matrixChunkConfig,
      accountId: undefined,
      gifPlayback: undefined,
    });
    expect(results).toEqual([{ channel: "matrix", messageId: "m1", roomId: "!room:example" }]);
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
                  media: true,
                  reconcileUnknownSend: true,
                },
                reconcileUnknownSendKinds: { text: true },
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

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          media: true,
          reconcileUnknownSend: true,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "capability_mismatch",
      capability: "reconcileUnknownSend",
    });
  });

  it("preserves global reconciliation declarations when the optional kind map is absent", async () => {
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
                capabilities: { text: true, reconcileUnknownSend: true },
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
        requirements: { text: true, reconcileUnknownSend: true },
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
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockImplementationOnce(async () => {
      order.push("mark-unknown");
    });
    queueMocks.markDeliveryPlatformSendDispatched.mockImplementationOnce(async () => {
      order.push("dispatch");
    });
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      order.push("send");
      await ctx.onPlatformSendDispatch?.();
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
                  reconcileUnknownSend: true,
                  afterSendSuccess: true,
                  afterCommit: true,
                },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
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
      requireUnknownSendReconciliation: true,
    });

    expect(order).toEqual([
      "queue",
      "before",
      "send",
      "dispatch",
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
    expect(beforeParams?.deliveryQueueId).toBe("queue-1");
    expect(queueMocks.markDeliveryPlatformSendDispatched).toHaveBeenCalledWith(
      "queue-1",
      undefined,
      expect.objectContaining({ replyToId: undefined, threadId: undefined }),
    );
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

  it("rejects provider-blocked deferred delivery before queue creation or platform work", async () => {
    const admitDeferredDelivery = vi.fn(() => ({
      status: "permanent_rejection" as const,
      reason: "unsupported_enterprise_slack_delivery",
    }));
    const messageSendText = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: { admitDeferredDelivery },
              send: { text: messageSendText },
            },
          },
        },
      ]),
    );

    const request = {
      cfg: {},
      channel: "matrix" as const,
      to: "!room:example",
      accountId: "enterprise",
      payloads: [{ text: "blocked" }],
    };
    await expect(deliverOutboundPayloads(request)).rejects.toThrow(
      "unsupported_enterprise_slack_delivery",
    );
    await expect(deliverOutboundPayloads({ ...request, skipQueue: true })).rejects.toThrow(
      "unsupported_enterprise_slack_delivery",
    );

    expect(admitDeferredDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "enterprise",
        channel: "matrix",
        phase: "live",
        to: "!room:example",
      }),
    );
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(admitDeferredDelivery).toHaveBeenCalledTimes(2);
    expect(messageSendText).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSending).not.toHaveBeenCalled();
  });

  it("continues best-effort sends when the precise dispatch timestamp cannot be refreshed", async () => {
    queueMocks.markDeliveryPlatformSendDispatched.mockRejectedValueOnce(
      new Error("dispatch state unavailable"),
    );
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      return {
        messageId: "message-adapter-1",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId: "message-adapter-1" }],
          kind: "text",
        }),
      };
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
              durableFinal: { capabilities: { text: true } },
              send: { text: messageSendText },
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
        queuePolicy: "best_effort",
      }),
    ).resolves.toHaveLength(1);
    expect(messageSendText).toHaveBeenCalledOnce();
    expect(logMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing best-effort send: dispatch state unavailable"),
    );
  });

  it("does not assign one durable delivery id to multiple payload sends", async () => {
    const messageSendText = vi.fn(async (_ctx: ChannelMessageSendTextContext) => ({
      messageId: "message-adapter-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId: "message-adapter-1" }],
        kind: "text",
      }),
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: { capabilities: { text: true } },
              send: { text: messageSendText },
            },
          },
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      queuePolicy: "required",
    });

    expect(messageSendText).toHaveBeenCalledTimes(2);
    for (const [ctx] of messageSendText.mock.calls) {
      expect(ctx.deliveryQueueId).toBeUndefined();
    }
  });

  it("rejects explicitly reconciled multi-payload sends before enqueue or platform I/O", async () => {
    const messageSendText = vi.fn();
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
                capabilities: { text: true, reconcileUnknownSend: true },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
              },
              send: { text: messageSendText },
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
        payloads: [{ text: "first" }, { text: "second" }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      }),
    ).rejects.toThrow(/unknown-send reconciliation requires exactly one payload/);
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(messageSendText).not.toHaveBeenCalled();
  });

  it("keeps ordinary required media sends independent of text-only reconciliation", async () => {
    const messageSendMedia = vi.fn(async () => ({
      messageId: "media-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId: "media-1" }],
        kind: "media",
      }),
    }));
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
                capabilities: { text: true, media: true, reconcileUnknownSend: true },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
              },
              send: { text: vi.fn(), media: messageSendMedia },
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
        payloads: [{ text: "caption", mediaUrl: "https://example.com/file.png" }],
        queuePolicy: "required",
      }),
    ).resolves.toHaveLength(1);
    expect(messageSendMedia).toHaveBeenCalledOnce();
  });

  it("keeps an explicitly reconciled send retryable when dispatch state cannot persist", async () => {
    queueMocks.markDeliveryPlatformSendDispatched.mockRejectedValueOnce(
      new Error("dispatch state unavailable"),
    );
    const platformSend = vi.fn();
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      platformSend();
      return {
        messageId: "message-adapter-1",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId: "message-adapter-1" }],
          kind: "text",
        }),
      };
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
                capabilities: { text: true, reconcileUnknownSend: true },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
              },
              send: { text: messageSendText },
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
        requireUnknownSendReconciliation: true,
      }),
    ).rejects.toThrow("dispatch state unavailable");
    expect(platformSend).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformSendAttemptStarted).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "dispatch state unavailable",
    );
  });

  it("rejects a required send before platform I/O when hooks change its reconciliable shape", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_payload_sending",
    );
    hookMocks.runner.runReplyPayloadSending.mockResolvedValueOnce({
      payload: { text: "hook media", mediaUrl: "https://example.com/hook.png" },
    });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
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
                  media: true,
                  messageSendingHooks: true,
                  reconcileUnknownSend: true,
                },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
              },
              send: { text: sendText, media: sendMedia },
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
        requireUnknownSendReconciliation: true,
        replyPayloadSendingHook: {
          kind: "final",
          channel: "matrix",
          context: { channelId: "matrix", conversationId: "!room:example" },
        },
      }),
    ).rejects.toThrow(/media unknown-send reconciliation is unavailable/);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("preserves unsupported send shapes when recovering a best-effort queue entry", async () => {
    const sendMedia = vi.fn(async () => ({
      messageId: "media-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "matrix", messageId: "media-1" }],
        kind: "media",
      }),
    }));
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
                capabilities: { text: true, media: true, reconcileUnknownSend: true },
                reconcileUnknownSendKinds: { text: true },
                reconcileUnknownSend: async () => ({ status: "not_sent" }),
              },
              send: {
                text: vi.fn(),
                media: sendMedia,
              },
            },
          },
        },
      ]),
    );

    for (const [index, queuePolicy] of ["best_effort", undefined].entries()) {
      await expect(
        deliverOutboundPayloads({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "caption", mediaUrl: "https://example.com/recovered.png" }],
          ...(queuePolicy ? { queuePolicy: "best_effort" as const } : {}),
          skipQueue: true,
          deliveryQueueId: `recovered-queue-${index}`,
        }),
      ).resolves.toHaveLength(1);
    }
    expect(sendMedia).toHaveBeenCalledTimes(2);
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
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
  });

  it("keeps a canceled zero-result delivery retryable when queue ack fails", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({
      cancel: true,
      content: "blocked",
    });
    queueMocks.ackDelivery.mockRejectedValueOnce(new Error("ack offline"));
    const sendMatrix = vi.fn();

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "best_effort",
    });

    expect(results).toStrictEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("failed to ack unsent delivery"),
    );
    expect(queueMocks.failDeliveryAfterPlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
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
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    queueMocks.enqueueDelivery.mockRejectedValueOnce(new Error("queue offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    try {
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
    } finally {
      unsubscribe();
    }

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "message.outbound.finished",
      status: "failed",
      outcome: "failed",
      failureStage: "queue",
      resultCount: 0,
    });
    expect(JSON.stringify(events)).not.toContain("queue offline");
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

  it("marks queued delivery as unknown-after-send (not failed) when a later payload fails after an earlier one succeeded", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1" })
      .mockRejectedValueOnce(new Error("second payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("second payload send failed");

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
  });

  it("retains retryable send-attempt state when the first platform call fails without a result", async () => {
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("first payload send failed");

    expect(queueMocks.markDeliveryPlatformSendAttemptStarted).toHaveBeenCalledWith(
      "mock-queue-id",
      undefined,
      { replyToId: null },
    );
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "first payload send failed",
    );
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["ECONNREFUSED", "connect"],
    ["ENOTFOUND", "getaddrinfo"],
    ["EAI_AGAIN", "getaddrinfo"],
    ["ENETDOWN", "connect"],
    ["ENETUNREACH", "connect"],
    ["EHOSTUNREACH", "connect"],
    ["UND_ERR_CONNECT_TIMEOUT", undefined],
    ["UND_ERR_DNS_RESOLVE_FAILED", undefined],
  ])("clears queued send evidence after a proven pre-connect %s failure", async (code, syscall) => {
    const networkError = Object.assign(new Error(`${syscall ?? "connect"} ${code}`), {
      code,
      ...(syscall ? { syscall } : {}),
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow(code);

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining(code),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("finds proven pre-connect failures nested in an aggregate cause", async () => {
    const aggregateError = Object.assign(
      new AggregateError([
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      ]),
      { code: "ECONNREFUSED" },
    );
    const networkError = new TypeError("fetch failed", { cause: aggregateError });
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow();

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.any(String),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("preserves send evidence for an aggregate with any ambiguous transport failure", async () => {
    const mixedError = Object.assign(
      new AggregateError([
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
        Object.assign(new Error("connection reset"), {
          code: "ECONNRESET",
          syscall: "read",
        }),
      ]),
      { code: "ECONNREFUSED" },
    );
    const sendMatrix = vi.fn().mockRejectedValueOnce(mixedError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow();

    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith("mock-queue-id", expect.any(String));
  });

  it("preserves send evidence when a safe terminal retry hides an ambiguous attempt", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("connection reset after write"), {
          code: "ECONNRESET",
          syscall: "read",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      );
    const sendMatrix = vi.fn(() =>
      retryAsync(request, { attempts: 2, minDelayMs: 0, maxDelayMs: 0 }),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("connect refused");

    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("connect refused"),
    );
  });

  it("clears send evidence only when every retry attempt failed before connect", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("dns unavailable"), {
          code: "EAI_AGAIN",
          syscall: "getaddrinfo",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      );
    const sendMatrix = vi.fn(() =>
      retryAsync(request, { attempts: 2, minDelayMs: 0, maxDelayMs: 0 }),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("connect refused");

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("connect refused"),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("preserves send evidence for an ambiguous cause on the terminal retry wrapper", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("connect refused"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      )
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connection reset after write"), {
            code: "ECONNRESET",
            syscall: "read",
          }),
        }),
      );
    const sendMatrix = vi.fn(() =>
      retryAsync(request, { attempts: 2, minDelayMs: 0, maxDelayMs: 0 }),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("fetch failed");

    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("connection reset after write"),
    );
  });

  it("trusts Undici's connect-timeout classification over its raw timeout cause", async () => {
    const connectTimeout = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      cause: new AggregateError([
        Object.assign(new Error("connect ETIMEDOUT"), {
          code: "ETIMEDOUT",
          syscall: "connect",
        }),
      ]),
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(connectTimeout);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("Connect Timeout Error");

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("Connect Timeout Error"),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("finds a DNS failure in the Slack Web API request-error wrapper", async () => {
    const networkError = Object.assign(new Error("getaddrinfo EAI_AGAIN slack.com"), {
      code: "EAI_AGAIN",
      syscall: "getaddrinfo",
    });
    const slackRequestError = Object.assign(new Error("A request error occurred"), {
      code: "slack_webapi_request_error",
      original: networkError,
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(slackRequestError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("A request error occurred");

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("A request error occurred"),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["ECONNREFUSED", undefined],
    ["ECONNRESET", "connect"],
  ])("retains queued send evidence for ambiguous %s failures", async (code, syscall) => {
    const networkError = Object.assign(new Error(`${syscall ?? "socket"} ${code}`), {
      code,
      ...(syscall ? { syscall } : {}),
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow(code);

    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining(code),
    );
  });

  it("clears queued send evidence for a best-effort pre-connect failure", async () => {
    const networkError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        bestEffort: true,
      }),
    ).resolves.toEqual([]);

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("clears queued send evidence for an all-not-dispatched best-effort failure", async () => {
    const sendMatrix = vi.fn().mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("upload timed out before completion dispatch", {
        cause: new Error("request timed out"),
      }),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        bestEffort: true,
      }),
    ).resolves.toEqual([]);

    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("preserves queued send evidence when a marked best-effort batch has an ambiguous failure", async () => {
    const ambiguousError = Object.assign(new Error("connect ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "connect",
    });
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "upload timed out before completion dispatch",
      { cause: new Error("request timed out") },
    );
    const sendMatrix = vi
      .fn()
      .mockRejectedValueOnce(ambiguousError)
      .mockRejectedValueOnce(notDispatchedError);

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }, { text: "second" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        bestEffort: true,
      }),
    ).resolves.toEqual([]);

    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
  });

  it("directly acks a sent delivery when the post-send unknown marker cannot be written", async () => {
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockRejectedValueOnce(
      new Error("unknown marker offline"),
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    });

    expect(sendMatrix).toHaveBeenCalled();
    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("runs sent-result commit hooks when marker fallback ack precedes a partial failure", async () => {
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockRejectedValueOnce(
      new Error("unknown marker offline"),
    );
    const afterCommit = vi.fn();
    const messageSendText = vi
      .fn()
      .mockResolvedValueOnce({
        messageId: "message-adapter-1",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId: "message-adapter-1" }],
          kind: "text",
        }),
      })
      .mockRejectedValueOnce(new Error("second send failed"));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            id: "matrix",
            message: {
              id: "matrix",
              durableFinal: { capabilities: { text: true, afterCommit: true } },
              send: { lifecycle: { afterCommit }, text: messageSendText },
            },
          },
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      bestEffort: true,
      queuePolicy: "required",
    });

    expect(results).toHaveLength(1);
    expect(queueMocks.ackDelivery).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("retains unknown-after-send evidence when both the marker and direct ack fail", async () => {
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockRejectedValueOnce(
      new Error("unknown marker offline"),
    );
    queueMocks.ackDelivery.mockRejectedValueOnce(new Error("ack offline"));
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    });

    expect(queueMocks.failDeliveryAfterPlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("marker=unknown marker offline; ack=ack offline"),
    );
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
    expect(queueMocks.failDeliveryAfterPlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("failed to ack sent delivery: ack offline"),
    );
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

  it("emits one metadata-only audit terminal for a successful logical payload", async () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    const sendMatrix = vi.fn().mockResolvedValue({
      messageId: "platform-message-1",
      roomId: "!room:example",
    });

    try {
      await deliverOutboundPayloads({
        cfg: matrixChunkConfig,
        channel: "matrix",
        to: "!room:target",
        accountId: "account-1",
        payloads: [{ text: "secret delivery body" }],
        deps: { matrix: sendMatrix },
        session: {
          key: "secret-session-key",
          agentId: "agent-main",
          conversationType: "direct",
        },
        replyPayloadSendingHook: {
          kind: "final",
          runId: "run-1",
          context: { channelId: "matrix" },
        },
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceId: "message:outbound:queue:mock-queue-id:payload:0",
      kind: "message",
      action: "message.outbound.finished",
      status: "succeeded",
      actorType: "agent",
      actorId: "agent-main",
      agentId: "agent-main",
      runId: "run-1",
      direction: "outbound",
      channel: "matrix",
      // Policy conversationType alone must not claim "direct" for a room
      // target; only declared destination facts or a matching route may.
      conversationKind: "unknown",
      outcome: "sent",
      deliveryKind: "text",
      resultCount: 1,
      accountId: "account-1",
      targetId: "!room:target",
      conversationId: "!room:example",
      messageId: "platform-message-1",
    });
    expect(typeof events[0]?.durationMs).toBe("number");
    expect(JSON.stringify(events)).not.toContain("secret delivery body");
    expect(JSON.stringify(events)).not.toContain("secret-session-key");
  });

  it("audits one durable terminal per logical payload in a mixed batch", async () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    const sendMatrix = vi.fn().mockResolvedValue({
      messageId: "visible",
      roomId: "!room:example",
    });

    try {
      await deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "NO_REPLY" }, { text: "visible reply" }],
        deps: { matrix: sendMatrix },
      });
    } finally {
      unsubscribe();
    }

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.outcome)).toEqual(["suppressed", "sent"]);
    expect(events[0]).toMatchObject({
      sourceId: "message:outbound:queue:mock-queue-id:payload:0",
      status: "blocked",
      actorType: "system",
      actorId: "gateway",
      conversationKind: "unknown",
      reasonCode: "no_visible_payload",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("deliveryKind");
    expect(events[1]).toMatchObject({
      sourceId: "message:outbound:queue:mock-queue-id:payload:1",
      status: "succeeded",
      outcome: "sent",
      resultCount: 1,
      messageId: "visible",
    });
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

  it("uses the base policy key for isolated heartbeat group media read denies", async () => {
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {
        tools: {
          allow: ["read"],
        },
        channels: {
          matrix: {
            groups: {
              ops: {
                toolsBySender: {
                  "id:attacker": {
                    deny: ["read"],
                  },
                },
              },
            },
          },
        } as OpenClawConfig["channels"],
      },
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "heartbeat media", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:group:ops:heartbeat",
        policyKey: "agent:main:matrix:group:ops",
        requesterSenderId: "attacker",
      },
    });

    const [mediaAccessOptions] = requireMockCall(resolveMediaAccessSpy, "media access") as [
      {
        requesterSenderId?: unknown;
        sessionKey?: unknown;
      },
    ];
    expect(mediaAccessOptions?.sessionKey).toBe("agent:main:matrix:group:ops");
    expect(mediaAccessOptions?.requesterSenderId).toBe("attacker");
    const sendOptions = requireMatrixSendCall(sendMatrix)[2] as Record<string, unknown>;
    expect(sendOptions.mediaReadFile).toBeUndefined();
    expect((sendOptions.mediaLocalRoots as readonly string[] | undefined) ?? []).not.toContain(
      "/tmp",
    );
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

  it("scopes media access after reply payload hooks add local media", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribeAudit = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_payload_sending",
    );
    hookMocks.runner.runReplyPayloadSending.mockResolvedValueOnce({
      payload: {
        text: "hook media",
        mediaUrl: "file:///tmp/hook-added.png",
      },
    });
    const resolveMediaAccessSpy = vi.spyOn(
      mediaCapabilityModule,
      "resolveAgentScopedOutboundMediaAccess",
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m5", roomId: "!room:example" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        agentId: "main",
        requesterSenderId: "sender-1",
      },
      replyPayloadSendingHook: {
        kind: "final",
        channel: "matrix",
        context: { channelId: "matrix", conversationId: "!room:example" },
      },
    });
    unsubscribeAudit();

    const [mediaAccessOptions] = requireMockCall(resolveMediaAccessSpy, "media access") as [
      {
        mediaSources?: unknown;
        requesterSenderId?: unknown;
        sessionKey?: unknown;
      },
    ];
    expect(mediaAccessOptions?.mediaSources).toEqual(["file:///tmp/hook-added.png"]);
    expect(mediaAccessOptions?.sessionKey).toBe("agent:main:matrix:room:ops");
    expect(mediaAccessOptions?.requesterSenderId).toBe("sender-1");
    const sendOptions = requireMatrixSendCall(sendMatrix)[2] as Record<string, unknown>;
    expect(sendOptions.mediaUrl).toBe("file:///tmp/hook-added.png");
    expect(typeof sendOptions.mediaReadFile).toBe("function");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({ outcome: "sent", deliveryKind: "media" });
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
    expect(payloadOutcomes).toMatchObject([
      { index: 0, status: "suppressed", reason: "no_visible_payload" },
      { index: 1, status: "sent" },
    ]);
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

  it("runs reply payload hooks before the final message_sending policy pass", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_payload_sending" || hookName === "message_sending",
    );
    hookMocks.runner.runReplyPayloadSending.mockImplementationOnce(async (event) => {
      const payload = (event as { payload: { text?: string } }).payload;
      return {
        payload: {
          ...payload,
          text: `${payload.text} + payload-hook`,
          replyToId: "hooked-reply",
        },
      };
    });
    hookMocks.runner.runMessageSending.mockResolvedValue({ content: "redacted" });
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix",
      messageId: "sent",
      roomId: "!room",
    });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "secret", replyToId: "original-reply" }],
      deps: { matrix: sendText },
      replyPayloadSendingHook: {
        kind: "final",
        channel: "matrix",
        context: { channelId: "matrix", conversationId: "!room" },
      },
    });

    expect(hookMocks.runner.runReplyPayloadSending).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ text: "secret" }),
        kind: "final",
        channel: "matrix",
      }),
      expect.objectContaining({ channelId: "matrix", conversationId: "!room" }),
    );
    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "secret + payload-hook",
        replyToId: "hooked-reply",
      }),
      expect.objectContaining({ channelId: "matrix", conversationId: "!room" }),
    );
    expect(requireMatrixSendCall(sendText)[1]).toBe("redacted");
    expect(queueMocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        replyPayloadSendingHook: expect.objectContaining({
          kind: "final",
          channel: "matrix",
        }),
      }),
    );
    expect(queueMocks.markDeliveryPlatformSendAttemptStarted).toHaveBeenCalledWith(
      "mock-queue-id",
      undefined,
      { replyToId: "hooked-reply" },
    );
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

  it("adapts presentation buttons to channel limits before rendering", async () => {
    const renderPresentation = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { rendered: true },
    }));
    const sendPayload = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "adapted",
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
              presentationCapabilities: {
                supported: true,
                buttons: true,
                limits: {
                  actions: {
                    maxActions: 1,
                    maxLabelLength: 4,
                    maxValueBytes: 8,
                    supportsStyles: false,
                  },
                },
              },
              renderPresentation,
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
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Reject", value: "reject", priority: 1, style: "danger" },
                  { label: "Approve", value: "approve", priority: 10, style: "success" },
                  { label: "Too long", value: "x".repeat(12), priority: 20 },
                ],
              },
            ],
          },
        },
      ],
    });

    const renderArg = requireMockCallArg(renderPresentation, "renderPresentation") as {
      presentation?: unknown;
    };
    expect(renderArg.presentation).toEqual({
      tone: undefined,
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Appr", value: "approve", priority: 10, style: undefined }],
        },
        {
          type: "context",
          text: "Actions:\n- Reje\n- Too",
        },
      ],
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

  it("persists formatted sub-send results before a later adapter chunk fails", async () => {
    const firstResult = { channel: "line" as const, messageId: "fmt-1" };
    const sendFormattedText = vi.fn(
      async (ctx: { onDeliveryResult?: (result: typeof firstResult) => Promise<void> | void }) => {
        await ctx.onDeliveryResult?.(firstResult);
        throw new Error("second formatted chunk failed");
      },
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
              sendText: async () => firstResult,
              sendFormattedText,
            },
          }),
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "line",
        to: "U123",
        payloads: [{ text: "two chunks" }],
        queuePolicy: "required",
      }),
    ).rejects.toThrow("second formatted chunk failed");

    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
  });

  it("preserves repeated platform identities across separate adapter invocations", async () => {
    const sendFormattedText = vi.fn(
      async (ctx: {
        onDeliveryResult?: (result: { channel: "line"; messageId: string }) => Promise<void> | void;
      }) => {
        const result = { channel: "line" as const, messageId: "push" };
        await ctx.onDeliveryResult?.(result);
        return [result];
      },
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
              sendText: async () => ({ channel: "line", messageId: "push" }),
              sendFormattedText,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: "first" }, { text: "second" }],
      queuePolicy: "required",
    });

    expect(sendFormattedText).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.messageId)).toEqual(["push", "push"]);
  });

  it("preserves repeated receipt IDs within one adapter invocation", async () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "line", messageId: "push" }],
      kind: "text",
    });
    const sendPayload = vi.fn(
      async (ctx: {
        onDeliveryResult?: (result: {
          channel: "line";
          messageId: string;
          receipt: typeof receipt;
        }) => Promise<void> | void;
      }) => {
        const result = { channel: "line" as const, messageId: "push", receipt };
        await ctx.onDeliveryResult?.(result);
        await ctx.onDeliveryResult?.(result);
        return result;
      },
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
              sendText: async () => ({ channel: "line", messageId: "unused" }),
              sendPayload,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: "text plus media", channelData: { line: { mode: "custom" } } }],
      queuePolicy: "required",
    });

    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.messageId)).toEqual(["push", "push"]);
  });

  it("replaces repeated progress IDs covered by aggregate receipt parts", async () => {
    const aggregateReceipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "line", messageId: "push" },
        { channel: "line", messageId: "push" },
      ],
      kind: "text",
    });
    const sendPayload = vi.fn(
      async (ctx: {
        onDeliveryResult?: (result: { channel: "line"; messageId: string }) => Promise<void> | void;
      }) => {
        await ctx.onDeliveryResult?.({ channel: "line", messageId: "push" });
        await ctx.onDeliveryResult?.({ channel: "line", messageId: "push" });
        return { channel: "line" as const, messageId: "push", receipt: aggregateReceipt };
      },
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
              sendText: async () => ({ channel: "line", messageId: "unused" }),
              sendPayload,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: "two pushes", channelData: { line: { mode: "custom" } } }],
      queuePolicy: "required",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
      "push",
      "push",
    ]);
  });

  it("replaces per-message progress with one aggregate final receipt", async () => {
    const aggregateReceipt = createMessageReceiptFromOutboundResults({
      results: [
        { channel: "line", messageId: "m1" },
        { channel: "line", messageId: "m2" },
      ],
      kind: "text",
    });
    const sendFormattedText = vi.fn(
      async (ctx: {
        onDeliveryResult?: (result: { channel: "line"; messageId: string }) => Promise<void> | void;
      }) => {
        await ctx.onDeliveryResult?.({ channel: "line", messageId: "m1" });
        await ctx.onDeliveryResult?.({ channel: "line", messageId: "m2" });
        return [
          {
            channel: "line" as const,
            messageId: "m2",
            receipt: aggregateReceipt,
          },
        ];
      },
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
              sendText: async () => ({ channel: "line", messageId: "unused" }),
              sendFormattedText,
            },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: "two chunks" }],
      queuePolicy: "required",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.receipt?.parts.map((part) => part.platformMessageId)).toEqual(["m1", "m2"]);
  });

  it("keeps commit hooks attached to a final result that replaces progress evidence", async () => {
    const afterCommit = vi.fn();
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId: "message-adapter-1" }],
      kind: "text",
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
              durableFinal: { capabilities: { text: true, afterCommit: true } },
              send: {
                lifecycle: { afterCommit },
                text: async (ctx: ChannelMessageSendTextContext) => {
                  const result = { messageId: "message-adapter-1", receipt };
                  await ctx.onDeliveryResult?.(result);
                  return result;
                },
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

    expect(results).toHaveLength(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
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

  it("respects newline chunk mode for plugin text without splitting short messages", async () => {
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

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    const firstChunkCall = requireMatrixSendCall(sendMatrix);
    expect(firstChunkCall?.[0]).toBe("!room:example");
    expect(firstChunkCall?.[1]).toBe("Line one\n\nLine two");
    expect((firstChunkCall?.[2] as { cfg?: unknown } | undefined)?.cfg).toBe(cfg);
  });

  it("splits long plugin text on packed paragraph boundaries in newline mode", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m1", roomId: "!room:example" })
      .mockResolvedValueOnce({ messageId: "m2", roomId: "!room:example" });
    const cfg: OpenClawConfig = {
      channels: {
        matrix: { textChunkLimit: 14, chunkMode: "newline" },
      } as OpenClawConfig["channels"],
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Alpha\n\nBeta\n\nGamma" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(2);
    const firstChunkCall = requireMatrixSendCall(sendMatrix);
    expect(firstChunkCall?.[0]).toBe("!room:example");
    expect(firstChunkCall?.[1]).toBe("Alpha\n\nBeta");
    expect((firstChunkCall?.[2] as { cfg?: unknown } | undefined)?.cfg).toBe(cfg);
    const secondChunkCall = sendMatrix.mock.calls[1];
    expect(secondChunkCall?.[0]).toBe("!room:example");
    expect(secondChunkCall?.[1]).toBe("Gamma");
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
      { text: "hi", mediaUrls: [], audioAsVoice: undefined },
      { text: "", mediaUrls: ["https://x.test/a.jpg"], audioAsVoice: undefined },
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

  it("records an all-failed bestEffort batch as a retryable attempt", async () => {
    const sendMatrix = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failed"))
      .mockRejectedValueOnce(new Error("second failed"));

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      deps: { matrix: sendMatrix },
      bestEffort: true,
    });

    expect(results).toStrictEqual([]);
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("calls failDelivery instead of ackDelivery on bestEffort partial failure without onError", async () => {
    await runBestEffortPartialFailureDelivery({ onError: false });

    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
  });

  it("logs a warning when failDelivery rejects on bestEffort partial failure (#83113)", async () => {
    queueMocks.failDelivery.mockRejectedValueOnce(new Error("queue storage down"));

    await runBestEffortPartialFailureDelivery();

    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
    const warnCall = requireMockCall(logMocks.warn, "warn");
    const warnMessage = String(warnCall[0]);
    expect(warnMessage).toContain("failed to mark queued delivery");
    expect(warnMessage).toContain("mock-queue-id");
    expect(warnMessage).toContain("queue storage down");
  });

  it("logs a warning when failDelivery rejects in the error handler (#83113)", async () => {
    const sendMatrix = vi.fn().mockRejectedValue(new Error("native send failed"));
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockRejectedValueOnce(
      new Error("pre-send marker offline"),
    );
    queueMocks.failDelivery.mockRejectedValueOnce(new Error("db connection lost"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("pre-send marker offline");

    expect(queueMocks.failDelivery).toHaveBeenCalledWith("mock-queue-id", expect.any(String));
    expect(sendMatrix).not.toHaveBeenCalled();
    const warnCall = requireMockCall(logMocks.warn, "warn");
    const warnMessage = String(warnCall[0]);
    expect(warnMessage).toContain("failed to mark queued delivery");
    expect(warnMessage).toContain("mock-queue-id");
    expect(warnMessage).toContain("db connection lost");
  });

  it("emits a stable terminal when best-effort marker fallback ack precedes provider rejection", async () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockRejectedValueOnce(
      new Error("pre-send marker offline"),
    );
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("provider rejected send"));

    try {
      await expect(
        deliverOutboundPayloads({
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "secret body" }],
          deps: { matrix: sendMatrix },
          queuePolicy: "best_effort",
        }),
      ).rejects.toThrow("provider rejected send");
    } finally {
      unsubscribe();
    }

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id", undefined);
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceId: "message:outbound:queue:mock-queue-id:payload:0",
      outcome: "failed",
      failureStage: "platform_send",
    });
    expect(JSON.stringify(events)).not.toContain("secret body");
    expect(JSON.stringify(events)).not.toContain("provider rejected send");
  });

  it("writes raw payloads to the queue before normalization", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-raw", roomId: "!room:example" });
    const rawPayloads: DeliverOutboundPayload[] = [
      { text: "NO_REPLY" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "caption", mediaUrl: "https://x.test/a.png" },
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
      { text: "caption", mediaUrl: "https://x.test/a.png" },
      { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
    ]);
    const renderedPlan = queuedDelivery?.renderedBatchPlan;
    expect(renderedPlan?.payloadCount).toBe(4);
    expect(renderedPlan?.textCount).toBe(4);
    expect(renderedPlan?.mediaCount).toBe(2);
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

  it("suppresses direct silent replies from the outbound session", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-silent", roomId: "!room" });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
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

    expect(sendMatrix).not.toHaveBeenCalled();
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

  it("does not mirror a full payload when only an internal sub-send succeeded", async () => {
    const partialResult = { channel: "line" as const, messageId: "partial-1" };
    const sendFormattedText = vi.fn(
      async (ctx: {
        onDeliveryResult?: (result: typeof partialResult) => Promise<void> | void;
      }) => {
        await ctx.onDeliveryResult?.(partialResult);
        throw new Error("second internal send failed");
      },
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
              sendText: async () => partialResult,
              sendFormattedText,
            },
          }),
        },
      ]),
    );
    mocks.appendAssistantMessageToSessionTranscript.mockClear();

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: "first part and unsent second part" }],
      bestEffort: true,
      mirror: {
        sessionKey: "agent:main:main",
        text: "first part and unsent second part",
      },
    });

    expect(results).toEqual([partialResult]);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("does not fail the channel send when the post-delivery transcript mirror throws", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockRejectedValueOnce(
      new Error("session file changed while embedded prompt lock was released"),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "done" }],
      deps: { matrix: sendMatrix },
      mirror: {
        sessionKey: "agent:main:main",
        text: "done",
        idempotencyKey: "idem-89626",
      },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toContain(
      "failed to mirror outbound delivery into session transcript; channel send already succeeded",
    );
    expect(warnCall[1]).toMatchObject({ channel: "matrix", sessionKey: "agent:main:main" });
  });

  it("does not fail the channel send when the transcript mirror reports not-ok", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockResolvedValueOnce({
      ok: false,
      reason: "session locked",
    });

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "done" }],
      deps: { matrix: sendMatrix },
      mirror: {
        sessionKey: "agent:main:main",
        text: "done",
        idempotencyKey: "idem-89626-b",
      },
    });

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    const warnCall = requireMockCall(logMocks.warn, "warn");
    expect(warnCall[0]).toContain(
      "failed to mirror outbound delivery into session transcript; channel send already succeeded",
    );
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

  it("threads sessionKey into the message_sending hook context when session is provided", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "mx-1",
      roomId: "!room",
    });
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

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "hello" }],
      session: { key: "agent:tank:main" },
    });

    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        channelId: "matrix",
        sessionKey: "agent:tank:main",
      }),
    );
  });

  it("forwards session.key (canonical) into message_sending ctx and never falls back to policyKey", async () => {
    // Contract test for OutboundSessionContext.key semantics:
    // session.key MUST reach plugins via ctx.sessionKey, even when a
    // different session.policyKey is also present. Delivery must not hand
    // the policy key to plugins that correlate against agent_end.
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "mx-3",
      roomId: "!room",
    });
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

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "hi" }],
      session: {
        key: "agent:tank:main",
        policyKey: "agent:tank:discord:tank:direct:1594",
      },
    });

    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sessionKey: "agent:tank:main" }),
    );
  });

  it("omits sessionKey from the message_sending hook context when session is absent", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "mx-2",
      roomId: "!room",
    });
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

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "hi" }],
    });

    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledTimes(1);
    const ctx = hookMocks.runner.runMessageSending.mock.calls[0]?.[1] as {
      sessionKey?: string;
    };
    expect(ctx?.sessionKey).toBeUndefined();
    expect(ctx).not.toHaveProperty("sessionKey");
  });

  it("threads sessionKey into the message_sent hook context when session is provided", async () => {
    // Contract test for `message_sent`: the documented JSDoc says the
    // outbound delivery hooks mirror `OutboundSessionContext.key`. This
    // test pins `message_sent` to that contract so it cannot diverge
    // from `message_sending` unobserved.
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "mx-sent-1",
      roomId: "!room",
    });
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

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "hello" }],
      session: { key: "agent:tank:main" },
    });

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ to: "!room", content: "hello", success: true }),
      expect.objectContaining({
        channelId: "matrix",
        sessionKey: "agent:tank:main",
      }),
    );
  });

  it("omits sessionKey from the message_sent hook context when session is absent", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendText = vi.fn().mockResolvedValue({
      channel: "matrix" as const,
      messageId: "mx-sent-2",
      roomId: "!room",
    });
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

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "hi" }],
    });

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledTimes(1);
    const sentCtx = hookMocks.runner.runMessageSent.mock.calls[0]?.[1] as {
      sessionKey?: string;
    };
    expect(sentCtx?.sessionKey).toBeUndefined();
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

  it("does not reuse a previous payload message id for a suppressed text send", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendText = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "" });
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
      payloads: [{ text: "first" }, { text: "second" }],
    });

    expect(results).toStrictEqual([{ channel: "matrix", messageId: "mx-1" }]);
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledTimes(2);
    expect(hookMocks.runner.runMessageSent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: "first",
        success: true,
        messageId: "mx-1",
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(hookMocks.runner.runMessageSent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: "second",
        success: false,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(hookMocks.runner.runMessageSent.mock.calls[1]?.[0]).not.toHaveProperty("messageId");
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
      gatewayClientScopes: ["operator.write"],
    });

    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
    expect(pinDeliveredMessage).toHaveBeenCalledTimes(1);
    const pinCall = requireMockCallArg(pinDeliveredMessage, "pin delivered message");
    expect(pinCall.gatewayClientScopes).toEqual(["operator.write"]);
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
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
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

    try {
      await expect(
        deliverOutboundPayloads({
          cfg: {},
          channel: "matrix",
          to: "!room:1",
          payloads: [{ text: "hello", delivery: { pin: { enabled: true, required: true } } }],
          skipQueue: true,
        }),
      ).rejects.toThrow("pin denied");
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "failed",
      errorCode: "message_delivery_partial_failure",
      outcome: "failed",
      failureStage: "platform_send",
      deliveryKind: "text",
      resultCount: 1,
      messageId: "mx-1",
    });
    expect(JSON.stringify(events)).not.toContain("pin denied");
  });

  it("keeps adapter side effects unknown when required pinning has no message identity", async () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "" });
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

    try {
      await expect(
        deliverOutboundPayloads({
          cfg: {},
          channel: "matrix",
          to: "!room:1",
          payloads: [{ text: "hello", delivery: { pin: { enabled: true, required: true } } }],
          skipQueue: true,
        }),
      ).rejects.toThrow("no delivered message id was returned");
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "unknown",
      outcome: "unknown",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("errorCode");
    expect(events[0]).not.toHaveProperty("deliveryKind");
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
