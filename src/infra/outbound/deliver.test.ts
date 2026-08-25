// Covers outbound delivery core: hooks, queue cleanup, durable capability
// checks, adapter sends, transcript mirroring, and payload outcomes.
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import { chunkText } from "../../auto-reply/chunk.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type {
  ChannelMessageSendResult,
  ChannelMessageSendMediaContext,
  ChannelMessageSendTextContext,
} from "../../channels/message/types.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import * as mediaCapabilityModule from "../../media/read-capability.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginHookRegistration } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../diagnostic-events.js";
import { retryAsync } from "../retry.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";

type AppendAssistantTranscript =
  (typeof import("../../config/sessions/transcript.js"))["appendAssistantMessageToSessionTranscript"];

type EnqueueDeliveryTestParams = Record<string, unknown> & {
  preparedBatch?: {
    entries?: Array<{
      payload?: Record<string, unknown> & { mediaUrl?: string };
      status?: unknown;
    }>;
  };
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
};

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn<AppendAssistantTranscript>(async () => ({
    ok: true,
    target: { sessionId: "x", sessionKey: "x", storePath: "/tmp/sessions.json" },
    messageId: "m",
  })),
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
  enqueueDelivery: vi.fn<(params: EnqueueDeliveryTestParams) => Promise<string>>(
    async () => "mock-queue-id",
  ),
  enqueueDeliveryOnce: vi.fn(async (_params: unknown, id: string) => ({ id, created: true })),
  enqueuePreparedDeliveryOnce: vi.fn(async (_params: unknown, id: string) => ({
    id,
    created: true,
  })),
  loadPendingDelivery: vi.fn(async () => null),
  findDeliveryIntentOwner: vi.fn<
    () => {
      namespace: "prepared" | "preparing" | "migration" | "legacy-preparing" | "legacy";
      status: "pending" | "failed" | "completed";
    } | null
  >(() => null),
  ackDelivery: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  failDelivery: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  failDeliveryAfterPlatformSend: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  failDeliveryBeforePlatformSend: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  moveToFailed: vi.fn<(...args: unknown[]) => Promise<string[]>>(async () => []),
  markDeliveryPlatformOutcomeUnknown: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  markDeliveryPlatformSendDispatched: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  markDeliveryPlatformSendAttemptStarted: vi.fn<(...args: unknown[]) => Promise<void>>(
    async () => {},
  ),
  claimReusableDeliveryPlatformSendAttempt: vi.fn(async () => "mock-producer-claim"),
  renewDeliveryPlatformSendLease: vi.fn(async () => Date.now() + 30_000),
  withActiveDeliveryClaim: vi.fn<
    (
      entryId: string,
      fn: () => Promise<unknown>,
    ) => Promise<{ status: "claimed"; value: unknown } | { status: "claimed-by-other-owner" }>
  >(async (_entryId, fn) => ({ status: "claimed", value: await fn() })),
  withStableDeliveryPreparation: vi.fn(),
}));
const completionMocks = vi.hoisted(() => ({
  completeDurableDelivery: vi.fn(),
  failDurableDelivery: vi.fn(),
  markDurableDeliveryQueued: vi.fn(async () => ({ state: "queued" as const })),
  rejectDurableDelivery: vi.fn(),
  suppressDurableDelivery: vi.fn(),
}));
const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

function withoutInitialProducerClaim(params: Record<string, unknown>): Record<string, unknown> {
  const { initialProducerClaim: _initialProducerClaim, ...queuedParams } = params;
  return queuedParams;
}

async function ackDeliveryMock(
  id: string,
  stateDir?: string,
  options?: {
    retainSpoolArtifacts?: boolean;
    suppressCompletionReceipt?: boolean;
    expectedPlatformSendAttemptId?: string | null;
  },
): Promise<void> {
  const { expectedPlatformSendAttemptId: _expectedPlatformSendAttemptId, ...legacyOptions } =
    options ?? {};
  const hasOptions = Object.keys(legacyOptions).length > 0;
  if (stateDir === undefined && !hasOptions) {
    return queueMocks.ackDelivery(id);
  }
  return queueMocks.ackDelivery(id, stateDir, hasOptions ? legacyOptions : undefined);
}

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
vi.mock("./delivery-queue-storage.js", () => ({
  enqueueDelivery: async (params: Record<string, unknown>) =>
    queueMocks.enqueueDelivery(withoutInitialProducerClaim(params)),
  enqueueDeliveryOnce: async (params: Record<string, unknown>, id: string) =>
    queueMocks.enqueueDeliveryOnce(withoutInitialProducerClaim(params), id),
  enqueuePreparedDeliveryOnce: async (params: Record<string, unknown>, id: string) =>
    queueMocks.enqueuePreparedDeliveryOnce(withoutInitialProducerClaim(params), id),
  ackDelivery: ackDeliveryMock,
  failDelivery: async (id: string, error: string) => queueMocks.failDelivery(id, error),
  failDeliveryAfterPlatformSend: async (id: string, error: string) =>
    queueMocks.failDeliveryAfterPlatformSend(id, error),
  failDeliveryBeforePlatformSend: async (id: string, error: string) =>
    queueMocks.failDeliveryBeforePlatformSend(id, error),
  moveToFailed: async (
    id: string,
    stateDir?: string,
    expectedPlatformSendAttemptId?: string | null,
  ) => queueMocks.moveToFailed(id, stateDir, expectedPlatformSendAttemptId),
  markDeliveryPlatformOutcomeUnknown: async (id: string) =>
    queueMocks.markDeliveryPlatformOutcomeUnknown(id),
  markDeliveryPlatformSendDispatched: async (
    id: string,
    stateDir?: string,
    route?: { replyToId?: string | null },
  ) => queueMocks.markDeliveryPlatformSendDispatched(id, stateDir, route),
  markDeliveryPlatformSendAttemptStarted: async (
    id: string,
    stateDir?: string,
    route?: { replyToId?: string | null },
  ) => queueMocks.markDeliveryPlatformSendAttemptStarted(id, stateDir, route),
  loadPendingDelivery: queueMocks.loadPendingDelivery,
  findDeliveryIntentOwner: queueMocks.findDeliveryIntentOwner,
}));
vi.mock("./delivery-queue-preparation.js", () => ({
  StableDeliveryPreparationLostError: class StableDeliveryPreparationLostError extends Error {},
  withStableDeliveryPreparation: queueMocks.withStableDeliveryPreparation,
}));
vi.mock("./delivery-queue-platform-lease.js", () => ({
  claimReusableDeliveryPlatformSendAttempt: queueMocks.claimReusableDeliveryPlatformSendAttempt,
  renewDeliveryPlatformSendLease: queueMocks.renewDeliveryPlatformSendLease,
}));
vi.mock("./delivery-queue-recovery.js", () => ({
  withActiveDeliveryClaim: queueMocks.withActiveDeliveryClaim,
}));
vi.mock("./delivery-completion.js", () => ({
  completeDurableDelivery: completionMocks.completeDurableDelivery,
  markDurableDeliveryQueued: completionMocks.markDurableDeliveryQueued,
  rejectDurableDelivery: completionMocks.rejectDurableDelivery,
  suppressDurableDelivery: completionMocks.suppressDurableDelivery,
  settleDurableDelivery: (
    completion: unknown,
    evidence: { result: unknown } | { platformSendStarted: boolean },
    stateDir?: string,
  ) =>
    "result" in evidence
      ? completionMocks.completeDurableDelivery(completion, evidence.result, stateDir)
      : evidence.platformSendStarted
        ? completionMocks.failDurableDelivery(completion, stateDir)
        : completionMocks.suppressDurableDelivery(completion, stateDir),
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
let deliverOutboundPayloadsInternal: DeliverModule["deliverOutboundPayloadsInternal"];
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

function requireMockCallArg<TArgs extends unknown[]>(
  mockFn: { mock: { calls: TArgs[] } },
  label: string,
  index = 0,
): TArgs[0] {
  const call = mockFn.mock.calls[index];
  if (!call || call.length === 0) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return call[0];
}

function requireMockCall<T extends unknown[] = unknown[]>(
  mockFn: { mock: { calls: T[] } },
  label: string,
  index = 0,
): T {
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

function createNetworkError(message: string, code: string, syscall?: string) {
  return Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });
}

function setTestPlugin(
  plugin: Pick<ChannelPlugin, "id"> & Partial<ChannelPlugin>,
  pluginId = plugin.id,
) {
  setActivePluginRegistry(createTestRegistry([{ pluginId, source: "test", plugin }]));
}

function createTestOutbound(
  overrides: Partial<ChannelOutboundAdapter> = {},
  id: Parameters<typeof createOutboundTestPlugin>[0]["id"] = "matrix",
): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async () => ({ channel: id, messageId: "unused" }),
    ...overrides,
  };
}

function setTestOutbound(
  overrides: Partial<ChannelOutboundAdapter>,
  id: Parameters<typeof createOutboundTestPlugin>[0]["id"] = "matrix",
) {
  setTestPlugin(createOutboundTestPlugin({ id, outbound: createTestOutbound(overrides, id) }));
}

type OutboundTextSender = NonNullable<ChannelOutboundAdapter["sendText"]>;
type OutboundMediaSender = NonNullable<ChannelOutboundAdapter["sendMedia"]>;
type OutboundPayloadSender = NonNullable<ChannelOutboundAdapter["sendPayload"]>;
type OutboundPinDeliveredMessage = NonNullable<ChannelOutboundAdapter["pinDeliveredMessage"]>;
type OutboundTextResult = Awaited<ReturnType<OutboundTextSender>>;
type OutboundPayloadResult = Awaited<ReturnType<OutboundPayloadSender>>;

function installTextOutbound(
  send: OutboundTextSender,
  overrides?: Omit<Partial<ChannelOutboundAdapter>, "sendText">,
  id?: Parameters<typeof createOutboundTestPlugin>[0]["id"],
): Mock<OutboundTextSender>;
function installTextOutbound<TResult extends OutboundTextResult>(
  send: TResult,
  overrides?: Omit<Partial<ChannelOutboundAdapter>, "sendText">,
  id?: Parameters<typeof createOutboundTestPlugin>[0]["id"],
): Mock<(ctx: Parameters<OutboundTextSender>[0]) => Promise<TResult>>;
function installTextOutbound(
  send: OutboundTextSender | OutboundTextResult,
  overrides: Omit<Partial<ChannelOutboundAdapter>, "sendText"> = {},
  id: Parameters<typeof createOutboundTestPlugin>[0]["id"] = "matrix",
) {
  const sendText =
    typeof send === "function"
      ? vi.fn(send)
      : vi.fn(async (_ctx: Parameters<OutboundTextSender>[0]) => send);
  setTestOutbound({ ...overrides, sendText }, id);
  return sendText;
}

function installPayloadOutbound(
  send: OutboundPayloadSender,
  overrides?: Omit<Partial<ChannelOutboundAdapter>, "sendPayload">,
  id?: Parameters<typeof createOutboundTestPlugin>[0]["id"],
): Mock<OutboundPayloadSender>;
function installPayloadOutbound<TResult extends OutboundPayloadResult>(
  send: TResult,
  overrides?: Omit<Partial<ChannelOutboundAdapter>, "sendPayload">,
  id?: Parameters<typeof createOutboundTestPlugin>[0]["id"],
): Mock<(ctx: Parameters<OutboundPayloadSender>[0]) => Promise<TResult>>;
function installPayloadOutbound(
  send: OutboundPayloadSender | OutboundPayloadResult,
  overrides: Omit<Partial<ChannelOutboundAdapter>, "sendPayload"> = {},
  id: Parameters<typeof createOutboundTestPlugin>[0]["id"] = "matrix",
) {
  const sendPayload =
    typeof send === "function"
      ? vi.fn(send)
      : vi.fn(async (_ctx: Parameters<OutboundPayloadSender>[0]) => send);
  setTestOutbound({ ...overrides, sendPayload }, id);
  return sendPayload;
}

function setMatrixMessageAdapter(
  message: NonNullable<ChannelPlugin["message"]>,
  outbound?: Partial<ChannelOutboundAdapter>,
) {
  setTestPlugin(
    outbound
      ? {
          ...createOutboundTestPlugin({ id: "matrix", outbound: createTestOutbound(outbound) }),
          message,
        }
      : { id: "matrix", message },
  );
}

type MatrixMessageAdapter = NonNullable<ChannelPlugin["message"]>;
type MatrixMessageTextSender = NonNullable<NonNullable<MatrixMessageAdapter["send"]>["text"]>;

function createMatrixMessageSendResult(
  messageId: string,
  kind: "media" | "text" = "text",
): ChannelMessageSendResult {
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "matrix", messageId }],
      kind,
    }),
  };
}

function installMatrixTextMessageAdapter(params: {
  messageId: string;
  durableFinal?: MatrixMessageAdapter["durableFinal"];
  lifecycle?: NonNullable<MatrixMessageAdapter["send"]>["lifecycle"];
  outbound?: Partial<ChannelOutboundAdapter>;
}) {
  const messageSendText = vi.fn<MatrixMessageTextSender>(async () =>
    createMatrixMessageSendResult(params.messageId),
  );
  setMatrixMessageAdapter(
    {
      id: "matrix",
      ...(params.durableFinal ? { durableFinal: params.durableFinal } : {}),
      send: { ...(params.lifecycle ? { lifecycle: params.lifecycle } : {}), text: messageSendText },
    },
    params.outbound,
  );
  return messageSendText;
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

type MatrixDeliveryArgs = Omit<DeliverOutboundArgs, "cfg" | "channel" | "to" | "payloads"> &
  Partial<Pick<DeliverOutboundArgs, "cfg" | "to" | "payloads">>;

function deliverMatrix(params: MatrixDeliveryArgs) {
  return deliverOutboundPayloads({
    cfg: {},
    channel: "matrix",
    to: "!room:example",
    payloads: [{ text: "hello" }],
    ...params,
  });
}

async function deliverMatrixPayload(params: {
  sendMatrix: MatrixSendFn;
  payload: DeliverOutboundPayload;
  cfg?: OpenClawConfig;
}) {
  return deliverMatrix({
    cfg: params.cfg ?? matrixChunkConfig,
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
  const results = await deliverMatrix({
    cfg,
    payloads: [{ text: "abcd" }],
    deps: { matrix: sendMatrix },
    ...(params?.mirror ? { mirror: params.mirror } : {}),
  });
  return { sendMatrix, results };
}

async function deliverSingleMatrixForHookTest(params?: { sessionKey?: string }) {
  const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
  await deliverMatrix({
    cfg: matrixChunkConfig,
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
  const results = await deliverMatrix({
    cfg,
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
      deliverOutboundPayloadsInternal,
      resolveOutboundDurableFinalDeliverySupport,
    } = await import("./deliver.js"));
  });

  beforeEach(() => {
    resetDiagnosticEventsForTest();
    setActivePluginRegistry(defaultRegistry);
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSending.mockResolvedValue(undefined);
    hookMocks.runner.runReplyPayloadSending.mockImplementation(async (event) => ({
      payload: (event as { payload?: unknown }).payload,
    }));
    hookMocks.runner.runMessageSent.mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.enqueueDeliveryOnce.mockImplementation(async (_params, id) => ({
      id,
      created: true,
    }));
    queueMocks.enqueuePreparedDeliveryOnce.mockImplementation(async (_params, id) => ({
      id,
      created: true,
    }));
    queueMocks.loadPendingDelivery.mockResolvedValue(null);
    queueMocks.findDeliveryIntentOwner.mockReturnValue(null);
    queueMocks.claimReusableDeliveryPlatformSendAttempt.mockResolvedValue("mock-producer-claim");
    queueMocks.renewDeliveryPlatformSendLease.mockImplementation(async () => Date.now() + 30_000);
    queueMocks.withStableDeliveryPreparation.mockReset();
    queueMocks.withStableDeliveryPreparation.mockImplementation(
      async (params: {
        id: string;
        run: (owner: {
          current: () => Record<string, unknown>;
          beforeFirstModifier: () => void;
          markPrepared: () => void;
          markPublished: () => void;
        }) => Promise<unknown>;
      }) => {
        if (queueMocks.findDeliveryIntentOwner()) {
          return { status: "existing" };
        }
        const entry = {
          id: params.id,
          enqueuedAt: 0,
          retryCount: 0,
          attemptCount: 0,
          preparationState: "claimed",
        };
        return {
          status: "claimed",
          value: await params.run({
            current: () => entry,
            beforeFirstModifier: () => {
              entry.preparationState = "modifiers_started";
            },
            markPrepared: () => {
              entry.preparationState = "prepared";
            },
            markPublished: () => {},
          }),
        };
      },
    );
    queueMocks.ackDelivery.mockResolvedValue(undefined);
    queueMocks.failDelivery.mockResolvedValue(undefined);
    queueMocks.failDeliveryAfterPlatformSend.mockResolvedValue(undefined);
    queueMocks.failDeliveryBeforePlatformSend.mockResolvedValue(undefined);
    queueMocks.moveToFailed.mockResolvedValue([]);
    queueMocks.markDeliveryPlatformOutcomeUnknown.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockResolvedValue(undefined);
    queueMocks.markDeliveryPlatformSendDispatched.mockResolvedValue(undefined);
    queueMocks.withActiveDeliveryClaim.mockImplementation(async (_entryId, fn) => ({
      status: "claimed",
      value: await fn(),
    }));
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    setActivePluginRegistry(emptyRegistry);
  });

  it("reports unsupported durable final delivery when required capabilities are missing", async () => {
    setTestOutbound({
      deliveryMode: "direct",
      sendText: async () => ({ channel: "matrix", messageId: "m1" }),
      deliveryCapabilities: {
        durableFinal: {
          text: true,
        },
      },
    });
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
    installMatrixTextMessageAdapter({
      messageId: "message",
      durableFinal: { capabilities: { text: true, silent: true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "matrix", messageId: "outbound" }),
        deliveryCapabilities: { durableFinal: { text: true } },
      },
    });
    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          silent: true,
        },
      }),
    ).resolves.toEqual({ ok: true, automaticUnknownSendReconciliation: false });
  });

  it("requires a real reconciler for required unknown-send recovery support", async () => {
    installMatrixTextMessageAdapter({
      messageId: "message",
      durableFinal: { capabilities: { text: true, reconcileUnknownSend: true } },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "matrix", messageId: "outbound" }),
      },
    });

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
    installMatrixTextMessageAdapter({
      messageId: "message",
      durableFinal: {
        capabilities: { text: true, media: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      outbound: {
        deliveryMode: "direct",
        sendText: async () => ({ channel: "matrix", messageId: "outbound" }),
      },
    });

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          reconcileUnknownSend: true,
        },
      }),
    ).resolves.toEqual({ ok: true, automaticUnknownSendReconciliation: false });

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
    installMatrixTextMessageAdapter({
      messageId: "message",
      durableFinal: {
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
    });
    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: { text: true, reconcileUnknownSend: true },
      }),
    ).resolves.toEqual({ ok: true, automaticUnknownSendReconciliation: false });
  });

  it("requires every concrete reconciliation kind for heterogeneous batches", async () => {
    installMatrixTextMessageAdapter({
      messageId: "message",
      durableFinal: {
        capabilities: { text: true, media: true, batch: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { media: true, batch: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
    });

    await expect(
      resolveOutboundDurableFinalDeliverySupport({
        cfg: {},
        channel: "matrix",
        requirements: {
          text: true,
          media: true,
          batch: true,
          reconcileUnknownSend: true,
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "capability_mismatch",
      capability: "reconcileUnknownSend",
    });
  });

  it("sends text through the channel message adapter when present", async () => {
    const outboundSendText = vi.fn(async () => ({
      channel: "matrix" as const,
      messageId: "outbound-1",
    }));
    const messageSendText = installMatrixTextMessageAdapter({
      messageId: "message-adapter-1",
      durableFinal: { capabilities: { text: true } },
      outbound: { chunker: chunkText, sendText: outboundSendText },
    });
    const results = await deliverMatrix({});

    const [sendTextParams] = expectDefined(
      (messageSendText.mock.calls as unknown as Array<[Record<string, unknown>]>)[0],
      "(messageSendText.mock.calls as unknown as Array<[Record<string, unknown>]>)[0] test invariant",
    );
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
    completionMocks.completeDurableDelivery.mockImplementationOnce(() => {
      order.push("complete");
    });
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      order.push("send");
      await ctx.onPlatformSendDispatch?.();
      return createMatrixMessageSendResult("message-adapter-1");
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
    setMatrixMessageAdapter({
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
        lifecycle: { beforeSendAttempt, afterSendSuccess, afterCommit },
        text: messageSendText,
      },
    });
    const results = await deliverMatrix({
      queuePolicy: "required",
      requireUnknownSendReconciliation: true,
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "operation-1",
        routeFingerprint: "route-1",
      },
      onDeliveryAttempt: async () => {},
    });

    expect(order).toEqual([
      "queue",
      "before",
      "send",
      "dispatch",
      "after:pending-1:message-adapter-1",
      "mark-unknown",
      "complete",
      "ack",
      "commit:pending-1:message-adapter-1",
    ]);
    const [beforeParams] = expectDefined(
      (beforeSendAttempt.mock.calls as unknown as Array<[Record<string, unknown>]>)[0],
      "(beforeSendAttempt.mock.calls as unknown as Array<[Record<string, unknown>]>)[0] test invariant",
    );
    expect(beforeParams?.kind).toBe("text");
    expect(beforeParams?.to).toBe("!room:example");
    expect(beforeParams?.text).toBe("hello");
    expect(beforeParams?.deliveryQueueId).toBe("queue-1");
    expect(queueMocks.markDeliveryPlatformSendDispatched).toHaveBeenCalledWith(
      "queue-1",
      undefined,
      expect.objectContaining({ replyToId: undefined, threadId: undefined }),
    );
    expect(queueMocks.markDeliveryPlatformSendDispatched).toHaveBeenCalledOnce();
    const [successParams] = expectDefined(
      (
        afterSendSuccess.mock.calls as unknown as Array<
          [Record<string, unknown> & { result?: { messageId?: string } }]
        >
      )[0],
      "(afterSendSuccess.mock.calls as unknown as Array<\n        [Record<string, unknown> & { result?: { messageId?: string } }]\n      >)[0] test invariant",
    );
    expect(successParams?.kind).toBe("text");
    expect(successParams?.attemptToken).toBe("pending-1");
    expect(successParams?.result?.messageId).toBe("message-adapter-1");
    const [commitParams] = expectDefined(
      (
        afterCommit.mock.calls as unknown as Array<
          [Record<string, unknown> & { result?: { messageId?: string } }]
        >
      )[0],
      "(afterCommit.mock.calls as unknown as Array<\n        [Record<string, unknown> & { result?: { messageId?: string } }]\n      >)[0] test invariant",
    );
    expect(commitParams?.kind).toBe("text");
    expect(commitParams?.attemptToken).toBe("pending-1");
    expect(commitParams?.result?.messageId).toBe("message-adapter-1");
    expect(results[0]?.channel).toBe("matrix");
    expect(results[0]?.messageId).toBe("message-adapter-1");
  });

  it("revalidates before direct adapter handoff when the adapter ignores the dispatch callback", async () => {
    const enteredPreflight = createDeferredCore();
    const resumePreflight = createDeferredCore();
    const messageSendText = installMatrixTextMessageAdapter({
      messageId: "must-not-send",
      lifecycle: {
        beforeSendAttempt: async () => {
          enteredPreflight.resolve();
          await resumePreflight.promise;
        },
      },
    });
    const onPlatformSendDispatch = vi.fn(async () => {
      throw new Error("turn authority closed");
    });

    const delivery = deliverMatrix({ skipQueue: true, onPlatformSendDispatch });
    await enteredPreflight.promise;
    resumePreflight.resolve();

    await expect(delivery).rejects.toThrow("turn authority closed");
    expect(messageSendText).not.toHaveBeenCalled();
  });

  it("fails closed for an unfinished conversation intent without route authority", async () => {
    const messageSendText = installMatrixTextMessageAdapter({
      messageId: "should-not-send",
      durableFinal: { capabilities: { text: true } },
    });

    await expect(
      deliverMatrix({
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "legacy-operation",
        },
        onDeliveryAttempt: async () => {},
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(messageSendText).not.toHaveBeenCalled();
  });

  it("does not claim platform custody when message adapter preflight fails", async () => {
    const messageSendText = vi.fn();
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: { capabilities: { text: true } },
      send: {
        lifecycle: {
          beforeSendAttempt: () => {
            throw new Error("preflight rejected");
          },
        },
        text: messageSendText,
      },
    });

    await expect(deliverMatrix({ queuePolicy: "required" })).rejects.toThrow("preflight rejected");
    expect(queueMocks.markDeliveryPlatformSendDispatched).not.toHaveBeenCalled();
    expect(messageSendText).not.toHaveBeenCalled();
  });

  it("does not cross platform I/O when a stable queue intent already exists", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sending");
    queueMocks.findDeliveryIntentOwner.mockReturnValue({
      namespace: "prepared",
      status: "completed",
    });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "must-not-send" });
    const onDeliveryIntent = vi.fn();

    await expect(
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: "operation-existing",
        onDeliveryIntent,
      }),
    ).rejects.toThrow("Stable delivery intent is already queued: operation-existing");
    expect(onDeliveryIntent).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSending).not.toHaveBeenCalled();
    expect(queueMocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("never falls back to fresh modifiers after another preparation owner wins", async () => {
    queueMocks.withStableDeliveryPreparation.mockResolvedValueOnce({ status: "existing" });
    queueMocks.loadPendingDelivery.mockResolvedValueOnce(null);
    queueMocks.findDeliveryIntentOwner.mockReturnValueOnce(null);
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sending");
    const sendMatrix = vi.fn();

    await expect(
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryIntentId: "transitioning-owner",
        reusePendingDeliveryIntent: true,
      }),
    ).rejects.toThrow("Stable delivery intent is already queued: transitioning-owner");
    expect(hookMocks.runner.runMessageSending).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("serializes stable intent preparation before modifiers can run twice", async () => {
    let active = false;
    queueMocks.withActiveDeliveryClaim.mockImplementation(async (_entryId, fn) => {
      if (active) {
        return { status: "claimed-by-other-owner" };
      }
      active = true;
      try {
        return { status: "claimed", value: await fn() };
      } finally {
        active = false;
      }
    });
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sending");
    let releaseModifier: (() => void) | undefined;
    hookMocks.runner.runMessageSending.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          releaseModifier = () => resolve(undefined);
        }),
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "stable-1" });
    const params = {
      deps: { matrix: sendMatrix },
      queuePolicy: "required" as const,
      deliveryIntentId: "operation-concurrent",
    };

    const first = deliverMatrix(params);
    await vi.waitFor(() => expect(hookMocks.runner.runMessageSending).toHaveBeenCalledOnce());
    expect(queueMocks.enqueueDeliveryOnce).not.toHaveBeenCalled();
    await expect(deliverMatrix(params)).rejects.toThrow(
      "Stable delivery intent is already queued: operation-concurrent",
    );
    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledOnce();
    releaseModifier?.();
    await expect(first).resolves.toHaveLength(1);
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("does not enter the modifier crash boundary when no modifying hook is registered", async () => {
    const onBeforeFirstModifier = vi.fn();

    await expect(
      prepareOutboundPayloadBatch(
        {
          cfg: {},
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "unchanged" }],
          deps: { matrix: vi.fn() },
          replyPayloadSendingHook: {
            kind: "final",
            context: { channelId: "matrix" },
          },
        },
        { onBeforeFirstModifier },
      ),
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ status: "accepted", payload: { text: "unchanged" } })],
    });
    expect(onBeforeFirstModifier).not.toHaveBeenCalled();
    expect(hookMocks.runner.runReplyPayloadSending).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSending).not.toHaveBeenCalled();
  });

  it("revalidates conversation authority after queue admission and before the adapter", async () => {
    const order: string[] = [];
    queueMocks.enqueueDelivery.mockImplementationOnce(async () => {
      order.push("queue");
      return "queue-route-authorization";
    });
    const sendMatrix = vi.fn(async () => {
      order.push("send");
      return { messageId: "message-1" };
    });

    await expect(
      deliverMatrix({
        payloads: [{ text: "hello" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-revoked",
          routeFingerprint: "route-revoked",
        },
        onDeliveryAttempt: async () => {
          order.push("authorize");
          throw new PlatformMessageNotDispatchedError("route was revoked", {
            cause: undefined,
            retryable: false,
          });
        },
      }),
    ).rejects.toThrow("route was revoked");

    expect(order).toEqual(["queue", "authorize"]);
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("finalizes owner state only after a chunked batch completes", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "chunk-1" })
      .mockResolvedValueOnce({ messageId: "chunk-2" });
    const onDeliveryAttempt = vi.fn(async () => {});

    await deliverMatrix({
      cfg: { channels: { matrix: { textChunkLimit: 2 } } } as OpenClawConfig,
      payloads: [{ text: "abcd" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "operation-chunked",
        routeFingerprint: "route-chunked",
      },
      onDeliveryAttempt,
    });

    expect(onDeliveryAttempt).toHaveBeenCalledOnce();
    expect(sendMatrix).toHaveBeenCalledTimes(2);
    expect(completionMocks.completeDurableDelivery).toHaveBeenCalledOnce();
    expect(completionMocks.completeDurableDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-chunked" }),
      expect.objectContaining({ messageId: "chunk-2" }),
      undefined,
    );
  });

  it("persists owner suppression before acknowledging its durable intent", async () => {
    const order: string[] = [];
    queueMocks.enqueueDelivery.mockImplementationOnce(async () => {
      order.push("queue");
      return "queue-suppressed";
    });
    completionMocks.suppressDurableDelivery.mockImplementationOnce(() => {
      order.push("suppress");
    });
    queueMocks.ackDelivery.mockImplementationOnce(async () => {
      order.push("ack");
    });
    const sendMatrix = vi.fn();

    const results = await deliverMatrix({
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "allow",
              internal: "allow",
            },
          },
        },
      },
      payloads: [{ text: "NO_REPLY" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:slash:!room",
        policyKey: "agent:main:matrix:direct:!room",
      },
      deliveryCompletion: {
        kind: "conversation",
        agentId: "main",
        operationId: "operation-suppressed",
        routeFingerprint: "route-suppressed",
      },
      onDeliveryAttempt: async () => {},
    });

    expect(results).toEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(order).toEqual(["queue", "suppress", "ack"]);
  });

  it("rejects provider-blocked deferred delivery before queue creation or platform work", async () => {
    const admitDeferredDelivery = vi.fn(() => ({
      status: "permanent_rejection" as const,
      reason: "unsupported_enterprise_slack_delivery",
    }));
    const messageSendText = vi.fn();
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: { admitDeferredDelivery },
      send: { text: messageSendText },
    });

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

  it("stops a claimed best-effort send when dispatch ownership cannot be refreshed", async () => {
    queueMocks.markDeliveryPlatformSendDispatched.mockRejectedValueOnce(
      new Error("dispatch state unavailable"),
    );
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      return createMatrixMessageSendResult("message-adapter-1");
    });
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: { capabilities: { text: true } },
      send: { text: messageSendText },
    });

    await expect(
      deliverMatrix({
        queuePolicy: "best_effort",
      }),
    ).rejects.toThrow("dispatch state unavailable");
    expect(messageSendText).toHaveBeenCalledOnce();
    expect(logMocks.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("continuing best-effort send: dispatch state unavailable"),
    );
  });

  it("does not assign one durable delivery id to multiple payload sends", async () => {
    const messageSendText = installMatrixTextMessageAdapter({
      messageId: "message-adapter-1",
      durableFinal: { capabilities: { text: true } },
    });

    await deliverMatrix({
      payloads: [{ text: "first" }, { text: "second" }],
      queuePolicy: "required",
    });

    expect(messageSendText).toHaveBeenCalledTimes(2);
    for (const [ctx] of messageSendText.mock.calls) {
      expect(ctx.deliveryQueueId).toBeUndefined();
    }
  });

  it("automatically enables provider reconciliation for one supported prepared payload", async () => {
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      return createMatrixMessageSendResult("message-adapter-1");
    });
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        automaticUnknownSendReconciliation: true,
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: messageSendText },
    });

    await deliverMatrix({ queuePolicy: "required" });

    expect(requireMockCallArg(queueMocks.enqueueDelivery, "enqueueDelivery")).toMatchObject({
      requireUnknownSendReconciliation: true,
    });
    expect(messageSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryQueueId: "mock-queue-id",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    );
  });

  it("leaves ordinary multi-payload delivery on the existing fail-closed path", async () => {
    const messageSendText = installMatrixTextMessageAdapter({
      messageId: "message-adapter-1",
      durableFinal: {
        automaticUnknownSendReconciliation: true,
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
    });

    await deliverMatrix({
      payloads: [{ text: "first" }, { text: "second" }],
      queuePolicy: "required",
    });

    expect(messageSendText).toHaveBeenCalledTimes(2);
    expect(messageSendText.mock.calls.map(([ctx]) => ctx.deliveryQueueId)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("rejects explicitly reconciled multi-payload sends before enqueue or platform I/O", async () => {
    const messageSendText = vi.fn();
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: messageSendText },
    });

    await expect(
      deliverMatrix({
        payloads: [{ text: "first" }, { text: "second" }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      }),
    ).rejects.toThrow(/unknown-send reconciliation requires exactly one payload/);
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(messageSendText).not.toHaveBeenCalled();
  });

  it("keeps ordinary required media sends independent of text-only reconciliation", async () => {
    const messageSendMedia = vi.fn(async () => createMatrixMessageSendResult("media-1", "media"));
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, media: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: vi.fn(), media: messageSendMedia },
    });

    await expect(
      deliverMatrix({
        payloads: [{ text: "caption", mediaUrl: "https://example.com/file.png" }],
        queuePolicy: "required",
      }),
    ).resolves.toHaveLength(1);
    expect(messageSendMedia).toHaveBeenCalledOnce();
  });

  it("keeps delivery directives on a reconciliable text transport", async () => {
    const messageSendText = installMatrixTextMessageAdapter({
      messageId: "pinned-text",
      durableFinal: {
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
    });

    await expect(
      deliverMatrix({
        payloads: [{ text: "pin this", delivery: { pin: true } }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      }),
    ).resolves.toHaveLength(1);
    expect(messageSendText).toHaveBeenCalledOnce();
  });

  it("passes stable part indexes to exact multi-media sends", async () => {
    const messageSendMedia = vi.fn(async (ctx: ChannelMessageSendMediaContext) =>
      createMatrixMessageSendResult(`media-${ctx.deliveryPartIndex}`, "media"),
    );
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, media: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { media: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: vi.fn(), media: messageSendMedia },
    });

    await expect(
      deliverMatrix({
        payloads: [
          {
            text: "caption",
            mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
          },
        ],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
      }),
    ).resolves.toHaveLength(2);
    expect(messageSendMedia.mock.calls.map(([ctx]) => ctx.deliveryPartIndex)).toEqual([0, 1]);
  });

  it("freezes reply-hook media fan-out into the exact prepared send", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_payload_sending",
    );
    hookMocks.runner.runReplyPayloadSending.mockResolvedValue({
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
      },
    });
    const messageSendMedia = vi.fn(async (ctx: ChannelMessageSendMediaContext) =>
      createMatrixMessageSendResult(`prepared-media-${ctx.deliveryPartIndex}`, "media"),
    );
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, media: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { media: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: vi.fn(), media: messageSendMedia },
    });

    await expect(
      deliverMatrix({
        payloads: [{ text: "caption", mediaUrl: "https://example.com/original.png" }],
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
        replyPayloadSendingHook: {
          kind: "final",
          channel: "matrix",
          context: { channelId: "matrix", conversationId: "!room:example" },
        },
      }),
    ).resolves.toHaveLength(2);
    expect(messageSendMedia.mock.calls.map(([ctx]) => ctx.deliveryPartIndex)).toEqual([0, 1]);
  });

  it("keeps an explicitly reconciled send retryable when dispatch state cannot persist", async () => {
    queueMocks.markDeliveryPlatformSendDispatched.mockRejectedValueOnce(
      new Error("dispatch state unavailable"),
    );
    const platformSend = vi.fn();
    const messageSendText = vi.fn(async (ctx: ChannelMessageSendTextContext) => {
      await ctx.onPlatformSendDispatch?.();
      platformSend();
      return createMatrixMessageSendResult("message-adapter-1");
    });
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: messageSendText },
    });

    await expect(
      deliverMatrix({
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
    setMatrixMessageAdapter({
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
    });

    await expect(
      deliverMatrix({
        queuePolicy: "required",
        requireUnknownSendReconciliation: true,
        replyPayloadSendingHook: {
          kind: "final",
          channel: "matrix",
          context: { channelId: "matrix", conversationId: "!room:example" },
        },
      }),
    ).rejects.toThrow(/prepared payload capability mismatch \(reconcileUnknownSend\)/);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("preserves unsupported send shapes when recovering a best-effort queue entry", async () => {
    const sendMedia = vi.fn(async () => createMatrixMessageSendResult("media-1", "media"));
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: {
        capabilities: { text: true, media: true, reconcileUnknownSend: true },
        reconcileUnknownSendKinds: { text: true },
        reconcileUnknownSend: async () => ({ status: "not_sent" }),
      },
      send: { text: vi.fn(), media: sendMedia },
    });

    for (const [index, queuePolicy] of ["best_effort", undefined].entries()) {
      await expect(
        deliverMatrix({
          payloads: [{ text: "caption", mediaUrl: "https://example.com/recovered.png" }],
          ...(queuePolicy ? { queuePolicy: "best_effort" as const } : {}),
          skipQueue: true,
          deliveryQueueId: `recovered-queue-${index}`,
        }),
      ).resolves.toHaveLength(1);
    }
    expect(sendMedia).toHaveBeenCalledTimes(2);
  });

  it("does not create a queue entry when hooks cancel before platform send", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({
      cancel: true,
      content: "blocked",
    });
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    const results = await deliverMatrix({
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    });

    expect(results).toStrictEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
  });

  it("keeps cancellation metadata live but out of durable prepared custody", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({
      cancel: true,
      cancelReason: "owned elsewhere",
      metadata: { nonJsonValue: 1n },
    });
    const outcomes: unknown[] = [];

    await expect(
      deliverMatrix({
        queuePolicy: "required",
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "suppressed-metadata",
          routeFingerprint: "route-suppressed-metadata",
        },
        onDeliveryAttempt: async () => {},
        onPayloadDeliveryOutcome: (outcome) => outcomes.push(outcome),
      }),
    ).resolves.toEqual([]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        status: "suppressed",
        hookEffect: {
          cancelReason: "owned elsewhere",
          metadata: { nonJsonValue: 1n },
        },
      }),
    ]);
  });

  it("does not involve queue recovery for a canceled zero-result delivery", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    hookMocks.runner.runMessageSending.mockResolvedValueOnce({
      cancel: true,
      content: "blocked",
    });
    const sendMatrix = vi.fn();

    const results = await deliverMatrix({
      deps: { matrix: sendMatrix },
      queuePolicy: "best_effort",
    });

    expect(results).toStrictEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDeliveryAfterPlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.markDeliveryPlatformOutcomeUnknown).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "runs message adapter failure cleanup for failed sends with pending attempt tokens",
      cleanupError: undefined,
    },
    {
      name: "preserves native send errors when failure cleanup throws",
      cleanupError: "cleanup failed",
    },
  ])("$name", async ({ cleanupError }) => {
    const messageSendText = vi.fn(async () => {
      throw new Error("native send failed");
    });
    const afterSendFailure = vi.fn(async () => {
      if (cleanupError) {
        throw new Error(cleanupError);
      }
    });
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: { capabilities: { text: true, afterSendSuccess: true } },
      send: {
        lifecycle: { beforeSendAttempt: () => "pending-2", afterSendFailure },
        text: messageSendText,
      },
    });

    await expect(
      deliverMatrix({
        queuePolicy: "required",
      }),
    ).rejects.toThrow("native send failed");

    const [failureParams] = expectDefined(
      (afterSendFailure.mock.calls as unknown as Array<[Record<string, unknown>]>)[0],
      "(afterSendFailure.mock.calls as unknown as Array<[Record<string, unknown>]>)[0] test invariant",
    );
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
    installMatrixTextMessageAdapter({
      messageId: "message-adapter-1",
      durableFinal: {
        capabilities: { text: true, afterSendSuccess: true, afterCommit: true },
      },
      lifecycle: {
        afterSendSuccess: async () => {
          throw new Error("success hook failed");
        },
        afterSendFailure,
        afterCommit,
      },
    });
    const results = await deliverMatrix({
      queuePolicy: "required",
    });

    expect(results[0]?.channel).toBe("matrix");
    expect(results[0]?.messageId).toBe("message-adapter-1");
    expect(afterSendFailure).not.toHaveBeenCalled();
    const [commitParams] = expectDefined(
      (
        afterCommit.mock.calls as unknown as Array<
          [Record<string, unknown> & { result?: { messageId?: string } }]
        >
      )[0],
      "(afterCommit.mock.calls as unknown as Array<\n        [Record<string, unknown> & { result?: { messageId?: string } }]\n      >)[0] test invariant",
    );
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
        deliverMatrix({
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

    const results = await deliverMatrix({
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "best_effort",
    });
    expect(results[0]?.messageId).toBe("m1");

    expect(sendMatrix).toHaveBeenCalled();
    // The lost write-ahead durability must leave a recorded reason: a crash
    // mid-send now loses the message with no queue row to recover.
    const warnLines = logMocks.warn.mock.calls.map((call) => String(call[0]));
    const queueWarn = warnLines.find((line) => line.includes("outbound queue write failed"));
    expect(queueWarn).toBeDefined();
    expect(queueWarn).toContain("channel=matrix");
    expect(queueWarn).toContain("queue offline");
  });

  it("emits one message_sent failure per payload when batch preparation fails", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sent" || hookName === "reply_payload_sending",
    );
    hookMocks.runner.runReplyPayloadSending.mockRejectedValueOnce(new Error("modifier exploded"));
    const sendMatrix = vi.fn();

    await expect(
      deliverMatrix({
        payloads: [{ text: "first payload" }, { text: "second payload" }],
        deps: { matrix: sendMatrix },
        replyPayloadSendingHook: {
          kind: "final",
          channel: "matrix",
          context: { channelId: "matrix", conversationId: "!room:example" },
        },
      }),
    ).rejects.toThrow("modifier exploded");

    expect(sendMatrix).not.toHaveBeenCalled();
    // Preparation aborts the whole batch: hooks must see every logical
    // payload fail, matching the per-payload audit terminals.
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledTimes(2);
    const contents = hookMocks.runner.runMessageSent.mock.calls.map(
      (call) => (call[0] as { content?: string }).content,
    );
    expect(contents).toEqual(["first payload", "second payload"]);
  });

  it("runs afterCommit hooks after best-effort queue fallback direct sends", async () => {
    queueMocks.enqueueDelivery.mockRejectedValueOnce(new Error("queue offline"));
    const afterCommit = vi.fn();
    installMatrixTextMessageAdapter({
      messageId: "message-adapter-1",
      durableFinal: { capabilities: { text: true, afterCommit: true } },
      lifecycle: { afterCommit },
    });

    await deliverMatrix({
      queuePolicy: "best_effort",
    });

    const [commitParams] = expectDefined(
      (
        afterCommit.mock.calls as unknown as Array<
          [Record<string, unknown> & { result?: { messageId?: string } }]
        >
      )[0],
      "(afterCommit.mock.calls as unknown as Array<\n        [Record<string, unknown> & { result?: { messageId?: string } }]\n      >)[0] test invariant",
    );
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
      deliverMatrix({
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
      deliverMatrix({
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
  ])(
    "dead-letters the queue entry after a proven pre-connect %s failure",
    async (code, syscall) => {
      const networkError = createNetworkError(`${syscall ?? "connect"} ${code}`, code, syscall);
      const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

      await expect(
        deliverMatrix({
          deps: { matrix: sendMatrix },
          queuePolicy: "required",
          deliveryRetryOwner: "caller",
        }),
      ).rejects.toThrow(code);

      expect(queueMocks.moveToFailed).toHaveBeenCalledWith(
        "mock-queue-id",
        undefined,
        expect.any(String),
      );
      expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
      expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    },
  );

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
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryRetryOwner: "caller",
      }),
    ).rejects.toThrow();

    expect(queueMocks.moveToFailed).toHaveBeenCalledWith(
      "mock-queue-id",
      undefined,
      expect.any(String),
    );
    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("keeps a reporting-only caller's entry recoverable after a proven pre-connect failure", async () => {
    const networkError = createNetworkError("connect ECONNREFUSED", "ECONNREFUSED", "connect");
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ECONNREFUSED");

    expect(queueMocks.moveToFailed).not.toHaveBeenCalled();
    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("ECONNREFUSED"),
    );
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("keeps a durable-completion entry recoverable after a proven pre-connect failure", async () => {
    const networkError = createNetworkError("connect ECONNREFUSED", "ECONNREFUSED", "connect");
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryRetryOwner: "caller",
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-proven-not-sent",
          routeFingerprint: "route-proven-not-sent",
        },
        onDeliveryAttempt: async () => {},
      }),
    ).rejects.toThrow("ECONNREFUSED");

    expect(queueMocks.moveToFailed).not.toHaveBeenCalled();
    expect(queueMocks.failDeliveryBeforePlatformSend).toHaveBeenCalledWith(
      "mock-queue-id",
      expect.stringContaining("ECONNREFUSED"),
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
      deliverMatrix({
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
      deliverMatrix({
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
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryRetryOwner: "caller",
      }),
    ).rejects.toThrow("connect refused");

    expect(queueMocks.moveToFailed).toHaveBeenCalledWith(
      "mock-queue-id",
      undefined,
      expect.any(String),
    );
    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
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
      deliverMatrix({
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
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryRetryOwner: "caller",
      }),
    ).rejects.toThrow("Connect Timeout Error");

    expect(queueMocks.moveToFailed).toHaveBeenCalledWith(
      "mock-queue-id",
      undefined,
      expect.any(String),
    );
    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("finds a DNS failure in the Slack Web API request-error wrapper", async () => {
    const networkError = createNetworkError(
      "getaddrinfo EAI_AGAIN slack.com",
      "EAI_AGAIN",
      "getaddrinfo",
    );
    const slackRequestError = Object.assign(new Error("A request error occurred"), {
      code: "slack_webapi_request_error",
      original: networkError,
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(slackRequestError);

    await expect(
      deliverMatrix({
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryRetryOwner: "caller",
      }),
    ).rejects.toThrow("A request error occurred");

    expect(queueMocks.moveToFailed).toHaveBeenCalledWith(
      "mock-queue-id",
      undefined,
      expect.any(String),
    );
    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it.each([
    ["ECONNREFUSED", undefined],
    ["ECONNRESET", "connect"],
  ])("retains queued send evidence for ambiguous %s failures", async (code, syscall) => {
    const networkError = createNetworkError(`${syscall ?? "socket"} ${code}`, code, syscall);
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverMatrix({
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
    const networkError = createNetworkError("connect ECONNREFUSED", "ECONNREFUSED", "connect");
    const sendMatrix = vi.fn().mockRejectedValueOnce(networkError);

    await expect(
      deliverMatrix({
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
      deliverMatrix({
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

  it("terminally retires a permanent provider rejection before platform dispatch", async () => {
    const order: string[] = [];
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    hookMocks.runner.runMessageSent.mockImplementationOnce(async () => {
      order.push("message-sent");
    });
    const rejection = new PlatformMessageNotDispatchedError("atomic message limit", {
      cause: new Error("rendered text is too large"),
      retryable: false,
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(rejection);
    completionMocks.rejectDurableDelivery.mockImplementationOnce(() => {
      order.push("reject-owner");
    });
    queueMocks.ackDelivery.mockImplementationOnce(async () => {
      order.push("ack-queue");
    });

    await expect(
      deliverMatrix({
        payloads: [{ text: "rendered text" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-rejected",
          routeFingerprint: "route-rejected",
        },
        onDeliveryAttempt: async () => {},
      }),
    ).rejects.toThrow("atomic message limit");

    expect(order).toEqual(["reject-owner", "ack-queue", "message-sent"]);
    expect(completionMocks.rejectDurableDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-rejected" }),
      "atomic message limit",
      undefined,
    );
    expect(queueMocks.failDeliveryBeforePlatformSend).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "rendered text",
        error: expect.stringContaining("atomic message limit"),
        success: false,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("normalizes an empty permanent rejection reason before durable retirement", async () => {
    const sendMatrix = vi.fn().mockRejectedValueOnce(
      new PlatformMessageNotDispatchedError("   ", {
        cause: new Error("provider rejected the rendered payload"),
        retryable: false,
      }),
    );

    await expect(
      deliverMatrix({
        payloads: [{ text: "rendered text" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
        deliveryCompletion: {
          kind: "conversation",
          agentId: "main",
          operationId: "operation-empty-rejection",
          routeFingerprint: "route-empty-rejection",
        },
        onDeliveryAttempt: async () => {},
      }),
    ).rejects.toThrow("Platform rejected the message before dispatch");

    expect(completionMocks.rejectDurableDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-empty-rejection" }),
      "Platform rejected the message before dispatch",
      undefined,
    );
  });

  it("preserves queued send evidence when a marked best-effort batch has an ambiguous failure", async () => {
    const ambiguousError = createNetworkError("connect ECONNRESET", "ECONNRESET", "connect");
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "upload timed out before completion dispatch",
      { cause: new Error("request timed out") },
    );
    const sendMatrix = vi
      .fn()
      .mockRejectedValueOnce(ambiguousError)
      .mockRejectedValueOnce(notDispatchedError);

    await expect(
      deliverMatrix({
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

    await deliverMatrix({
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
      .mockResolvedValueOnce(createMatrixMessageSendResult("message-adapter-1"))
      .mockRejectedValueOnce(new Error("second send failed"));
    setMatrixMessageAdapter({
      id: "matrix",
      durableFinal: { capabilities: { text: true, afterCommit: true } },
      send: { lifecycle: { afterCommit }, text: messageSendText },
    });

    const results = await deliverMatrix({
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

    await deliverMatrix({
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
      deliverMatrix({
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
      await deliverMatrix({
        cfg: matrixChunkConfig,
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
      await deliverMatrix({
        cfg: matrixChunkConfig,
        payloads: [{ text: "secret delivery body" }],
        deps: { matrix: sendMatrix },
        bestEffort: true,
        session: { key: "session-1" },
      });
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const deliveryEvents = events.filter((event) => event.type.startsWith("message.delivery."));
    expect(deliveryEvents.map((event) => event.type)).toEqual([
      "message.delivery.started",
      "message.delivery.error",
    ]);
    const errorEvent = deliveryEvents[1] as Record<string, unknown> | undefined;
    expect(errorEvent?.type).toBe("message.delivery.error");
    expect(errorEvent?.channel).toBe("matrix");
    expect(errorEvent?.deliveryKind).toBe("text");
    expect(typeof errorEvent?.durationMs).toBe("number");
    expect(errorEvent?.errorCategory).toBe("TypeError");
    expect(errorEvent?.sessionKey).toBe("session-1");
    expect(JSON.stringify(deliveryEvents)).not.toContain("secret delivery body");
  });

  it("emits one metadata-only audit terminal for a successful logical payload", async () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    const sendMatrix = vi.fn().mockResolvedValue({
      messageId: "platform-message-1",
      target: { kind: "room", id: "!room:example" },
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

    expect(events.map((event) => event.outcome)).toEqual(["queued", "platform_started", "sent"]);
    expect(events[2]).toMatchObject({
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
    expect(typeof events[2]?.durationMs).toBe("number");
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
      await deliverMatrix({
        payloads: [{ text: "NO_REPLY" }, { text: "visible reply" }],
        deps: { matrix: sendMatrix },
      });
    } finally {
      unsubscribe();
    }

    expect(sendMatrix).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.outcome)).toEqual([
      "queued",
      "queued",
      "platform_started",
      "suppressed",
      "sent",
    ]);
    expect(events[3]).toMatchObject({
      sourceId: "message:outbound:queue:mock-queue-id:payload:0",
      status: "blocked",
      actorType: "system",
      actorId: "gateway",
      conversationKind: "unknown",
      reasonCode: "no_visible_payload",
      resultCount: 0,
    });
    expect(events[3]).not.toHaveProperty("deliveryKind");
    expect(events[4]).toMatchObject({
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

    await deliverMatrix({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterSenderId: "attacker",
      },
    });

    const [mediaAccessOptions] = requireMockCall<
      [{ messageProvider?: unknown; requesterSenderId?: unknown; sessionKey?: unknown }]
    >(resolveMediaAccessSpy, "media access");
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

    await deliverMatrix({
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
      payloads: [{ text: "heartbeat media", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:group:ops:heartbeat",
        policyKey: "agent:main:matrix:group:ops",
        requesterSenderId: "attacker",
      },
    });

    const [mediaAccessOptions] = requireMockCall<
      [{ requesterSenderId?: unknown; sessionKey?: unknown }]
    >(resolveMediaAccessSpy, "media access");
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

    await deliverMatrix({
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

    const [mediaAccessOptions] = requireMockCall<
      [
        {
          requesterSenderE164?: unknown;
          requesterSenderId?: unknown;
          requesterSenderName?: unknown;
          requesterSenderUsername?: unknown;
        },
      ]
    >(resolveMediaAccessSpy, "media access");
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

    await deliverMatrix({
      accountId: "destination-account",
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/policy.png" }],
      deps: { matrix: sendMatrix },
      session: {
        key: "agent:main:matrix:room:ops",
        requesterAccountId: "source-account",
        requesterSenderId: "attacker",
      },
    });

    const [mediaAccessOptions] = requireMockCall<
      [{ accountId?: unknown; requesterSenderId?: unknown; sessionKey?: unknown }]
    >(resolveMediaAccessSpy, "media access");
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

    await deliverMatrix({
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

    await deliverMatrix({
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

    const [mediaAccessOptions] = requireMockCall<
      [{ mediaSources?: unknown; requesterSenderId?: unknown; sessionKey?: unknown }]
    >(resolveMediaAccessSpy, "media access");
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
    const sendText = installTextOutbound(
      async ({ text }) => ({ channel: "matrix", messageId: text, roomId: "!room" }),
      {
        textChunkLimit: 2,
        chunker: (text, limit) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks;
        },
      },
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

  it("keeps a prepared transport-id delivery atomic", async () => {
    const sendText = installTextOutbound(
      { channel: "matrix", messageId: "prepared-1", roomId: "!room" },
      {
        textChunkLimit: 2,
        chunker: (text, limit) => [text.slice(0, limit), text.slice(limit)],
      },
    );

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: { textChunkLimit: 2 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "abcd" }],
      preparedMessageId: "prepared-1",
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: "abcd", preparedMessageId: "prepared-1" }),
    );
    expect(queueMocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ preparedMessageId: "prepared-1" }),
    );
  });

  it("uses replyToId only on the first low-level send for single-use reply modes", async () => {
    const sendText = installTextOutbound(
      async ({ text }) => ({ channel: "matrix", messageId: text, roomId: "!room" }),
      {
        textChunkLimit: 2,
        chunker: (text, limit) => {
          const chunks: string[] = [];
          for (let i = 0; i < text.length; i += limit) {
            chunks.push(text.slice(i, i + limit));
          }
          return chunks;
        },
      },
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
    const sendText = installTextOutbound(async ({ text }) => ({
      channel: "matrix",
      messageId: text,
      roomId: "!room",
    }));

    await deliverMatrix({
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
    const sendText = installTextOutbound(async ({ text }) => ({
      channel: "matrix",
      messageId: text,
      roomId: "!room",
    }));

    await deliverMatrix({
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
    const sendText = installTextOutbound({
      channel: "matrix",
      messageId: "should-not-send",
      roomId: "!room",
    });

    const results = await deliverMatrix({
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

    const results = await deliverMatrix({
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
    const sendText = installTextOutbound({
      channel: "matrix",
      messageId: "clean",
      roomId: "!room",
    });

    await deliverMatrix({
      to: "!room",
      payloads: [{ text: "original" }],
    });

    expect(requireMockCallArg(sendText, "sendText").text).toBe("visible");
  });

  it("strips complete inline runtime context blocks before channel delivery", async () => {
    const sendText = installTextOutbound({
      channel: "matrix",
      messageId: "clean-inline-runtime-context",
      roomId: "!room",
    });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room",
      payloads: [
        {
          text: "before <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>private runtime metadata<<<END_OPENCLAW_INTERNAL_CONTEXT>>> after",
        },
      ],
    });

    expect(requireMockCallArg(sendText, "sendText").text).toBe("before  after");
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

    await deliverMatrix({
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
        preparedBatch: expect.objectContaining({
          entries: [expect.objectContaining({ status: "accepted", sourceIndex: 0 })],
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
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "clean", roomId: "!room" },
      {
        normalizePayload: ({ payload }) => ({
          ...payload,
          channelData: { copiedText: payload.text },
        }),
        sendMedia: vi.fn(),
      },
    );

    await deliverMatrix({
      to: "!room",
      payloads: [{ text: "original" }],
    });

    const deliveredPayload = requireMockCallArg(sendPayload, "sendPayload").payload as
      | { channelData?: unknown; text?: unknown }
      | undefined;
    expect(deliveredPayload?.text).toBe("visible");
    expect(deliveredPayload?.channelData).toStrictEqual({ copiedText: "visible" });
    expect(queueMocks.enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedBatch: expect.objectContaining({
          entries: [
            expect.objectContaining({
              payload: expect.objectContaining({
                text: "visible",
                channelData: { copiedText: "visible" },
              }),
            }),
          ],
        }),
      }),
    );
  });

  it("passes delivery config and account context to adapter payload normalization", async () => {
    const normalizePayload = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { normalized: true },
    }));
    const cfg = { channels: { matrix: { enabled: true } } } as unknown as OpenClawConfig;
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "context", roomId: "!room" },
      { normalizePayload, sendMedia: vi.fn() },
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

  it("normalizes low-level prepared batches that did not pass channel preparation", async () => {
    const normalizePayload = vi.fn((payload) => ({
      ...payload,
      channelData: { normalized: payload.text },
    }));
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "low-level-normalized", roomId: "!room" },
      { normalizePayload: ({ payload }) => normalizePayload(payload) },
    );
    const payload = { text: "portable" };

    await deliverMatrix({
      payloads: [payload],
      preparedBatch: createUnmodifiedPreparedOutboundBatch([payload]),
    });

    expect(normalizePayload).toHaveBeenCalledOnce();
    expect(requireMockCallArg(sendPayload, "sendPayload").payload).toMatchObject({
      text: "portable",
      channelData: { normalized: "portable" },
    });
  });

  it("passes ordered source indexes through adapter batch normalization", async () => {
    const normalizePayloadBatch = vi.fn<
      NonNullable<ChannelOutboundAdapter["normalizePayloadBatch"]>
    >(({ payloads }) => [
      {
        ...payloads[0]?.payload,
        channelData: { merged: payloads.map((entry) => entry.index) },
      },
      null,
    ]);
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "merged", roomId: "!room" },
      { normalizePayloadBatch },
    );

    await deliverMatrix({
      to: "!room",
      payloads: [{ text: "First" }, { text: "Second" }],
    });

    expect(normalizePayloadBatch).toHaveBeenCalledTimes(1);
    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(requireMockCallArg(sendPayload, "sendPayload").payload).toMatchObject({
      text: "First",
      channelData: { merged: [0, 1] },
    });
  });

  it("strips internal runtime scaffolding copied into rendered and normalized nested payloads", async () => {
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "clean-nested", roomId: "!room" },
      {
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
            channelData: { ...payload.channelData, normalizedText: text },
            interactive: { blocks: [{ type: "text", text }] },
          };
        },
        sendMedia: vi.fn(),
      },
    );

    await deliverMatrix({
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

  it("prefers the account-aware presentation capability resolver over the static declaration", async () => {
    const renderPresentation = vi.fn(({ payload }) => ({ ...payload, text: "native table" }));
    const resolvePresentationCapabilities = vi.fn(() => ({ supported: true, tables: true }));
    installPayloadOutbound(
      { channel: "matrix", messageId: "caps", roomId: "!room" },
      {
        presentationCapabilities: { supported: true, tables: false },
        resolvePresentationCapabilities,
        renderPresentation,
        sendMedia: vi.fn(),
      },
    );

    await deliverMatrix({
      to: "!room",
      payloads: [
        {
          text: "authored fallback",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [{ type: "table", caption: "Totals", headers: ["A"], rows: [["1"]] }],
          },
        },
      ],
    });

    expect(resolvePresentationCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: expect.anything() }),
    );
    // With only the static tables:false declaration the table would degrade and
    // the authored fallback text would ship without invoking the renderer; the
    // resolver's tables:true must keep the block native.
    const renderArg = requireMockCallArg(renderPresentation, "renderPresentation") as {
      presentation?: { blocks?: Array<{ type?: string }> };
    };
    expect(renderArg.presentation?.blocks?.[0]?.type).toBe("table");
  });

  it("keeps authored fallback text when formatting-aware capabilities disable tables", async () => {
    const renderPresentation = vi.fn(({ payload }) => ({ ...payload, text: "native table" }));
    const resolvePresentationCapabilities = vi.fn(
      (params: { formatting?: { parseMode?: string } }) => ({
        supported: true,
        tables: params.formatting?.parseMode !== "HTML",
      }),
    );
    const sendText = installTextOutbound(
      { channel: "matrix", messageId: "html-fallback", roomId: "!room" },
      {
        presentationCapabilities: { supported: true, tables: true },
        resolvePresentationCapabilities,
        renderPresentation,
        sendMedia: vi.fn(),
      },
    );

    await deliverMatrix({
      to: "!room",
      formatting: { parseMode: "HTML" },
      payloads: [
        {
          text: "authored fallback",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [{ type: "table", caption: "Totals", headers: ["A"], rows: [["1"]] }],
          },
        },
      ],
    });

    expect(resolvePresentationCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ formatting: expect.objectContaining({ parseMode: "HTML" }) }),
    );
    // The formatting-aware resolver disables tables for HTML-mode sends, so the
    // authored fallback body ships verbatim instead of a degraded flatten.
    expect(renderPresentation).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "authored fallback" }));
  });

  it("adapts presentation buttons to channel limits before rendering", async () => {
    const renderPresentation = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { rendered: true },
    }));
    installPayloadOutbound(
      { channel: "matrix", messageId: "adapted", roomId: "!room" },
      {
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
        sendMedia: vi.fn(),
      },
    );

    await deliverMatrix({
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
          text: "Actions:\n- Reject\n- Too long",
        },
      ],
    });
  });

  it("uses runtime fallback text only when native presentation rendering is unavailable", async () => {
    const nativeRender = vi.fn(({ payload }) => ({
      ...payload,
      channelData: { native: true },
    }));
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "question-card", roomId: "!room" },
      {
        presentationCapabilities: { supported: true, buttons: true },
        renderPresentation: nativeRender,
        sendMedia: vi.fn(),
      },
    );

    await deliverMatrix({
      to: "!room",
      payloads: [
        {
          text: "Question with numbered fallback",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              { type: "text", text: "Question" },
              { type: "buttons", buttons: [{ label: "Yes", value: "yes" }] },
            ],
          },
        },
      ],
    });

    expect(requireMockCallArg(nativeRender, "native renderer").payload).toMatchObject({
      text: undefined,
      presentationTextMode: "fallback",
    });
    expect(requireMockCallArg(sendPayload, "send payload").payload).toMatchObject({
      channelData: { native: true },
      text: undefined,
    });
  });

  it("keeps runtime presentation fallback text exact on button-less channels", async () => {
    const sendText = installTextOutbound({
      channel: "matrix",
      messageId: "question-text",
      roomId: "!room",
    });

    await deliverMatrix({
      to: "!room",
      payloads: [
        {
          text: "Question\n1. Yes\n2. No",
          presentationTextMode: "fallback",
          presentation: {
            blocks: [
              { type: "text", text: "Question" },
              { type: "buttons", buttons: [{ label: "Yes", value: "yes" }] },
            ],
          },
        },
      ],
    });

    expect(requireMockCallArg(sendText, "send text").text).toBe("Question\n1. Yes\n2. No");
  });

  it("preserves full presentation labels when bounded native rendering declines", async () => {
    const sendText = installTextOutbound(
      { channel: "matrix", messageId: "full-labels", roomId: "!room" },
      {
        presentationCapabilities: {
          supported: true,
          buttons: true,
          selects: true,
          limits: {
            actions: { maxLabelLength: 4 },
            selects: { maxLabelLength: 4 },
            text: { maxLength: 18, encoding: "characters" },
          },
        },
        renderPresentation: vi.fn(() => null),
      },
    );

    await deliverMatrix({
      to: "!room",
      payloads: [
        {
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [{ label: "Approve production", value: "approve" }],
              },
              {
                type: "select",
                placeholder: "Deployment target",
                options: [{ label: "Production cluster", value: "production" }],
              },
            ],
          },
        },
      ],
    });

    expect(requireMockCallArg(sendText, "send text").text).toBe(
      "- Approve production\n\nDeployment target:\n- Production cluster",
    );
  });

  it("reassembles bounded fallback fragments when native presentation rendering succeeds", async () => {
    const sendText = installTextOutbound(
      { channel: "matrix", messageId: "joined-labels", roomId: "!room" },
      {
        presentationCapabilities: {
          supported: true,
          buttons: false,
          limits: { text: { maxLength: 18, encoding: "characters" } },
        },
        renderPresentation: ({ payload, presentation }) => ({
          ...payload,
          text: renderMessagePresentationFallbackText({ presentation }),
        }),
      },
    );

    await deliverMatrix({
      to: "!room",
      payloads: [
        {
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Approve production", value: "approve" },
                  { label: "Rollback release", value: "rollback" },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(requireMockCallArg(sendText, "send text").text).toBe(
      "Actions:\n- Approve production\n- Rollback release",
    );
  });

  it("runs adapter after-delivery hooks with the payload delivery results", async () => {
    const afterDeliverPayload = vi.fn();
    setTestOutbound({
      sendText: async ({ text }) => ({ channel: "matrix" as const, messageId: text }),
      afterDeliverPayload,
    });

    await deliverMatrix({
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
    setTestOutbound({ sendText, sendMedia, sendFormattedText, sendFormattedMedia }, "line");

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
    setTestOutbound({ sendText: async () => firstResult, sendFormattedText }, "line");

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

  it("runs partial after-delivery bookkeeping once with rendered payload and accepted target", async () => {
    const platformError = new Error("second formatted chunk failed");
    const firstResult = {
      channel: "line" as const,
      messageId: "fmt-1",
      meta: { visibleText: "native formatted prefix" },
    };
    const afterDeliverPayload = vi.fn(async () => {
      throw new Error("observer failed");
    });
    const onError = vi.fn();
    setTestOutbound(
      {
        renderPresentation: ({ payload }) => ({ ...payload, text: "native formatted prefix" }),
        sendFormattedText: async (ctx) => {
          await ctx.onDeliveryResult?.(firstResult);
          throw platformError;
        },
        sendText: async () => firstResult,
        adoptTargetFromDelivery: ({ result }) =>
          result.messageId === "fmt-1" ? { threadId: "thread-from-platform" } : null,
        afterDeliverPayload,
      },
      "line",
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [
        {
          text: "fallback",
          presentation: { blocks: [{ type: "context", text: "native" }] },
        },
      ],
      bestEffort: true,
      skipQueue: true,
      onError,
    });

    expect(results).toEqual([firstResult]);
    expect(afterDeliverPayload).toHaveBeenCalledOnce();
    expect(afterDeliverPayload).toHaveBeenCalledWith({
      cfg: {},
      target: {
        channel: "line",
        to: "U123",
        accountId: undefined,
        threadId: "thread-from-platform",
      },
      payload: { text: "native formatted prefix" },
      results: [firstResult],
    });
    expect(onError).toHaveBeenCalledWith(
      platformError,
      expect.objectContaining({ text: "native formatted prefix" }),
    );
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
    setTestOutbound(
      { sendText: async () => ({ channel: "line", messageId: "push" }), sendFormattedText },
      "line",
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
    setTestOutbound({ sendPayload }, "line");

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
    setTestOutbound({ sendPayload }, "line");

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
    setTestOutbound({ sendFormattedText }, "line");

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
    setMatrixMessageAdapter({
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
    });

    const results = await deliverMatrix({
      queuePolicy: "required",
    });

    expect(results).toHaveLength(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it("includes OpenClaw tmp root in plugin mediaLocalRoots", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-media", roomId: "!room" });

    await deliverMatrix({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
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
    const sendMedia = vi
      .fn<OutboundMediaSender>()
      .mockResolvedValue({ channel: "matrix", messageId: "m1" });
    setTestOutbound({
      sendText: vi.fn().mockResolvedValue({ channel: "matrix", messageId: "text-1" }),
      sendMedia,
    });

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
    const sendMediaOptions = requireMockCallArg(sendMedia, "sendMedia");
    expect(sendMediaOptions?.to).toBe("!explicit:example");
    expect(sendMediaOptions?.text).toBe("HEARTBEAT_OK");
    expect(sendMediaOptions?.mediaUrl).toBe("https://example.com/img.png");
    expect(sendMediaOptions?.accountId).toBeUndefined();
  });

  it("forwards audioAsVoice through generic plugin media delivery", async () => {
    const sendMedia = vi.fn(async (_ctx: Parameters<OutboundMediaSender>[0]) => ({
      channel: "matrix",
      messageId: "mx-1",
      roomId: "!room:example",
    }));
    setTestOutbound({
      sendText: async ({ to, text }) => ({ channel: "matrix", messageId: `${to}:${text}` }),
      sendMedia,
    });

    await deliverOutboundPayloads({
      cfg: { channels: { matrix: {} } } as OpenClawConfig,
      channel: "matrix",
      to: "room:!room:example",
      payloads: [{ text: "voice caption", mediaUrl: "file:///tmp/clip.mp3", audioAsVoice: true }],
    });

    const sendMediaOptions = requireMockCallArg(sendMedia, "sendMedia");
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
    const sendMedia = vi.fn(async (_ctx: Parameters<OutboundMediaSender>[0]) => ({
      channel: "matrix",
      messageId: "mx-voice",
      roomId: "!room:example",
    }));
    setTestOutbound({ sendText: vi.fn(), sendMedia });

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
    const sendMediaOptions = requireMockCallArg(sendMedia, "sendMedia");
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

    await deliverMatrix({
      cfg,
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

    await deliverMatrix({
      cfg,
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
    setTestOutbound({
      chunker: (text, limit) => {
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          chunks.push(text.slice(i, i + limit));
        }
        return chunks;
      },
      textChunkLimit: 4000,
      sendText,
    });

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
    setTestOutbound({
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
    });

    await deliverOutboundPayloadsInternal({
      cfg: { channels: { matrix: { textChunkLimit: 4000 } } } as OpenClawConfig,
      channel: "matrix",
      to: "!room",
      payloads: [{ text: "line one\nline two" }],
      replyToId: "reply-1",
      replyToMode: "first",
      conversationReadOrigin: "direct-operator",
      formatting: { maxLinesPerMessage: 1 },
    });

    expect(sendText.mock.calls.map((call) => call[0]?.text)).toEqual(["line one", "line two"]);
    expect(sendText.mock.calls.map((call) => call[0]?.replyToId)).toEqual(["reply-1", undefined]);
    expect(
      sendText.mock.calls.map(
        (call) => (call[0] as { conversationReadOrigin?: string })?.conversationReadOrigin,
      ),
    ).toEqual(["direct-operator", "direct-operator"]);
    expect(queueMocks.enqueueDelivery.mock.calls[0]?.[0]).not.toHaveProperty(
      "conversationReadOrigin",
    );
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
    const results = await deliverMatrix({
      payloads: [{ text: "<br>" }],
      deps: { matrix: sendMatrix },
    });

    expect(sendMatrix).not.toHaveBeenCalled();
    expect(results).toStrictEqual([]);
  });

  it("reports transport-normalized text only after identified delivery", async () => {
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: "m-normalized",
      roomId: "!room:example",
      text,
    }));
    setTestOutbound({ sanitizeText: ({ text }) => `[safe] ${text}`, sendText });
    const deliveredPayloads: Array<{ text: string; mediaUrls: string[] }> = [];

    await deliverOutboundPayloadsInternal({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "hello" }],
      onDeliveredPayload: (payload) => deliveredPayloads.push(payload),
    });

    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "[safe] hello" }));
    expect(deliveredPayloads).toEqual([{ text: "[safe] hello", mediaUrls: [] }]);
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
    setTestOutbound({
      chunker,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      sendText,
      sendMedia,
    });

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
    setTestOutbound({
      chunker,
      chunkerMode: "markdown",
      chunkedTextFormatting: { parseMode: "HTML" },
      textChunkLimit: 4000,
      sendText,
    });

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
    setTestOutbound(matrixOutboundForTest);
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverMatrix({
      cfg,
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

    await deliverMatrix({
      cfg: matrixChunkConfig,
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
    setTestOutbound({ ...matrixOutboundForTest, extractMarkdownImages: true });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [{ text: "Chart ![chart](https://example.com/chart.png) now" }],
      deps: { matrix: sendMatrix },
    });

    const sendMatrixCall = requireMatrixSendCall(sendMatrix);
    const sendMatrixOptions = sendMatrixCall[2] as { mediaUrl?: unknown } | undefined;
    expect(sendMatrixCall[0]).toBe("!room:example");
    expect(sendMatrixCall[1]).toBe("Chart now");
    expect(sendMatrixOptions?.mediaUrl).toBe("https://example.com/chart.png");
  });

  it.each([
    {
      name: "MEDIA directives",
      text: "Caption\nMEDIA:https://example.com/one.png\nMEDIA:https://example.com/two.png",
      extractMarkdownImages: false,
    },
    {
      name: "Markdown images",
      text: "Caption ![one](https://example.com/one.png) ![two](https://example.com/two.png)",
      extractMarkdownImages: true,
    },
  ])("delivers explicit attachments and every extracted $name", async (testCase) => {
    const sendMedia = vi.fn<NonNullable<ChannelOutboundAdapter["sendMedia"]>>(async () => ({
      channel: "matrix",
      messageId: "sent",
    }));
    setTestOutbound({
      ...matrixOutboundForTest,
      sendMedia,
      extractMarkdownImages: testCase.extractMarkdownImages,
    });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [
        {
          text: testCase.text,
          mediaUrl: "https://example.com/primary.png",
          mediaUrls: ["https://example.com/explicit.png", "https://example.com/one.png"],
        },
      ],
    });

    expect(sendMedia.mock.calls.map(([params]) => params.mediaUrl)).toEqual([
      "https://example.com/explicit.png",
      "https://example.com/one.png",
      "https://example.com/primary.png",
      "https://example.com/two.png",
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

    await deliverMatrix({
      cfg: matrixChunkConfig,
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

    const results = await deliverMatrix({
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
      deliverMatrix({
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
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sent",
    );
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockRejectedValueOnce(
      new Error("pre-send marker offline"),
    );
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("provider rejected send"));

    try {
      await expect(
        deliverMatrix({
          payloads: [{ text: "secret body" }],
          deps: { matrix: sendMatrix },
          queuePolicy: "best_effort",
        }),
      ).rejects.toThrow("provider rejected send");
    } finally {
      unsubscribe();
    }

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledOnce();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "secret body", success: false }),
      expect.objectContaining({ channelId: "matrix" }),
    );
    expect(events.map((event) => event.outcome)).toEqual(["queued", "platform_started", "failed"]);
    expect(events[2]).toMatchObject({
      sourceId: "message:outbound:queue:mock-queue-id:payload:0",
      outcome: "failed",
      failureStage: "platform_send",
    });
    expect(JSON.stringify(events)).not.toContain("secret body");
    expect(JSON.stringify(events)).not.toContain("provider rejected send");
  });

  it("flushes terminal observers when marker fallback ack precedes an abort", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sent",
    );
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockRejectedValueOnce(
      new Error("pre-send marker offline"),
    );
    const abort = new Error("operator stopped delivery");
    abort.name = "AbortError";
    const sendMatrix = vi.fn().mockRejectedValueOnce(abort);

    await expect(
      deliverMatrix({
        payloads: [{ text: "stopped body" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "best_effort",
      }),
    ).rejects.toThrow("operator stopped delivery");

    expect(queueMocks.ackDelivery).toHaveBeenCalledTimes(1);
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledOnce();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "stopped body", success: false }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("retains queue media when recovery acks before adapter I/O", async () => {
    queueMocks.markDeliveryPlatformSendAttemptStarted.mockRejectedValueOnce(
      new Error("pre-send marker offline"),
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });

    await deliverMatrix({
      deps: { matrix: sendMatrix },
      queuePolicy: "best_effort",
      skipQueue: true,
      deliveryQueueId: "recovery-queue-id",
      deliveryQueueStateDir: "/queue-state",
    });

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("recovery-queue-id", "/queue-state", {
      retainSpoolArtifacts: true,
    });
    expect(sendMatrix).toHaveBeenCalledOnce();
  });

  it("writes accepted post-policy payloads to the queue", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-raw", roomId: "!room:example" });
    const rawPayloads: DeliverOutboundPayload[] = [
      { text: "NO_REPLY" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "caption", mediaUrl: "https://x.test/a.png" },
      { text: "NO_REPLY", mediaUrl: " https://x.test/b.png " },
    ];

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: rawPayloads,
      deps: { matrix: sendMatrix },
    });

    expect(queueMocks.enqueueDelivery).toHaveBeenCalledTimes(1);
    const queuedDelivery = requireMockCallArg(queueMocks.enqueueDelivery, "enqueueDelivery");
    expect(
      queuedDelivery?.preparedBatch?.entries?.flatMap((entry) =>
        entry.status === "accepted" ? [entry.payload] : [],
      ),
    ).toStrictEqual([
      { text: "caption", mediaUrl: "https://x.test/a.png" },
      { text: "", mediaUrl: "https://x.test/b.png" },
    ]);
    const renderedPlan = queuedDelivery?.renderedBatchPlan;
    expect(renderedPlan?.payloadCount).toBe(2);
    expect(renderedPlan?.textCount).toBe(1);
    expect(renderedPlan?.mediaCount).toBe(2);
    const mediaOnlyItem = renderedPlan?.items?.find((item) => item.index === 1);
    expect(mediaOnlyItem?.kinds).toStrictEqual(["media"]);
    expect(mediaOnlyItem?.mediaUrls).toStrictEqual(["https://x.test/b.png"]);
  });

  it("strips internal runtime scaffolding before queue persistence", async () => {
    const sendMatrix = vi
      .fn()
      .mockResolvedValue({ messageId: "m-internal", roomId: "!room:example" });

    await deliverMatrix({
      cfg: matrixChunkConfig,
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

    const queuedDelivery = requireMockCallArg(queueMocks.enqueueDelivery, "enqueueDelivery");
    expect(
      queuedDelivery?.preparedBatch?.entries?.flatMap((entry) =>
        entry.status === "accepted" ? [entry.payload] : [],
      ),
    ).toStrictEqual([
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
        {
          index: 0,
          kinds: ["text"] as const,
          text: "provider-visible hello",
          mediaUrls: [],
        },
        { index: 1, kinds: ["media"] as const, mediaUrls: ["https://example.com/a.png"] },
      ],
    };

    const payloads = [{ text: "hello" }, { mediaUrl: "https://example.com/a.png" }];
    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads,
      preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
      deps: { matrix: sendMatrix },
      renderedBatchPlan,
    });

    const queuedDelivery = requireMockCallArg(queueMocks.enqueueDelivery, "enqueueDelivery");
    expect(queuedDelivery?.renderedBatchPlan).toEqual(renderedBatchPlan);
  });

  it("queues a spool copy while the live send keeps the producer's path", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-spool", roomId: "!room:example" });
    // Production shape: no explicit mediaAccess, and the source sits in the
    // OpenClaw temp root that TTS actually writes to. Staging must resolve the
    // same capability the live send resolves, so a fabricated localRoots here
    // would hide whether the two gates agree.
    const sourceDir = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "deliver-spool-")),
    );
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-deliver-spool-state-",
    });
    // Real MPEG-1 Layer III frames: host-local media sends are buffer-verified,
    // so placeholder text would be rejected before staging is even exercised.
    const source = path.join(sourceDir, "voice.mp3");
    const mp3 = Buffer.alloc(417 * 8);
    for (let i = 0; i < 8; i++) {
      const o = i * 417;
      mp3[o] = 0xff;
      mp3[o + 1] = 0xfb;
      mp3[o + 2] = 0x90;
      mp3[o + 3] = 0xc4;
    }
    await fsPromises.writeFile(source, mp3);
    const payload = { mediaUrl: source, audioAsVoice: true };

    try {
      await deliverMatrix({
        cfg: matrixChunkConfig,
        payloads: [payload],
        deps: { matrix: sendMatrix },
      });

      const queued = requireMockCallArg(queueMocks.enqueueDelivery, "enqueueDelivery");
      const queuedMediaUrl = queued?.preparedBatch?.entries?.find(
        (entry) => entry.status === "accepted",
      )?.payload?.mediaUrl;
      // The row points at the queue's own copy...
      expect(queuedMediaUrl).not.toBe(source);
      expect(await fsPromises.readFile(queuedMediaUrl as string)).toEqual(mp3);
      // ...while the live send stays copy-free on the producer's path.
      expect(payload.mediaUrl).toBe(source);
      expect(sendMatrix.mock.calls[0]?.[0]?.mediaUrl ?? source).toBe(source);
    } finally {
      await fsPromises.rm(sourceDir, { recursive: true, force: true });
      await openClawState.cleanup();
    }
  });

  it("stages agent-workspace media that only the agent-scoped capability can read", async () => {
    // The regression this guards: queue staging must resolve the same media
    // capability the live send resolves. An agent workspace lives at
    // <state>/workspace-<agentId>, which the unscoped default roots explicitly
    // reject (see local-media-access.ts), so staging that reads through a raw
    // params.mediaAccess would refuse media the send itself would deliver.
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-ws", roomId: "!room:example" });
    // workspaceOnly pins the grant to the agent: it suppresses the parent-root
    // expansion that would otherwise admit any declared source directory, so the
    // workspace root can only come from the agent-scoped capability.
    const workspaceOnlyConfig = {
      ...matrixChunkConfig,
      tools: { fs: { workspaceOnly: true } },
    } as OpenClawConfig;
    // Deliberately outside the OpenClaw temp root: that root is itself a default
    // media root, so a state dir inside it would admit the source by containment
    // and hide whether the agent-scoped capability is what grants access.
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-deliver-ws-",
    });
    const stateDir = openClawState.stateDir;
    const workspaceDir = path.join(stateDir, "workspace-proofagent");
    // Host-local sends are buffer-verified, so the fixture needs real audio.
    const source = path.join(workspaceDir, "voice.mp3");
    const mp3 = Buffer.alloc(417 * 8);
    for (let i = 0; i < 8; i++) {
      const o = i * 417;
      mp3[o] = 0xff;
      mp3[o + 1] = 0xfb;
      mp3[o + 2] = 0x90;
      mp3[o + 3] = 0xc4;
    }
    const payload = { mediaUrl: source, audioAsVoice: true };

    try {
      await fsPromises.mkdir(workspaceDir, { recursive: true });
      await fsPromises.writeFile(source, mp3);
      await deliverMatrix({
        cfg: workspaceOnlyConfig,
        payloads: [payload],
        session: { key: "session-ws", agentId: "proofagent" },
        deps: { matrix: sendMatrix },
      });

      const queued = requireMockCallArg(queueMocks.enqueueDelivery, "enqueueDelivery");
      const queuedMediaUrl = queued?.preparedBatch?.entries?.find(
        (entry) => entry.status === "accepted",
      )?.payload?.mediaUrl;
      // A durable row exists at all only if staging resolved the agent-scoped
      // capability; the raw capability rejects this source outright.
      expect(queuedMediaUrl).toBeDefined();
      expect(queuedMediaUrl).not.toBe(source);
      expect(await fsPromises.readFile(queuedMediaUrl as string)).toEqual(mp3);
      // The live send still carries the agent's own path, uncopied.
      expect(payload.mediaUrl).toBe(source);
      expect(sendMatrix).toHaveBeenCalled();
    } finally {
      await openClawState.cleanup();
    }
  });

  it("keeps a best-effort send live-only when its media cannot be staged", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-live", roomId: "!room:example" });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [{ mediaUrl: "/nonexistent/voice.ogg" }],
      deps: { matrix: sendMatrix },
    });

    // No durable row may claim media it cannot replay; the send still goes out.
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(sendMatrix).toHaveBeenCalled();
  });

  it("fails a required send closed when its media cannot be staged", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-req", roomId: "!room:example" });

    await expect(
      deliverMatrix({
        cfg: matrixChunkConfig,
        payloads: [{ mediaUrl: "/nonexistent/voice.ogg" }],
        queuePolicy: "required",
        deps: { matrix: sendMatrix },
      }),
    ).rejects.toThrow();

    // Required durability cannot be honored, so nothing reaches the recipient.
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
  });

  it("fails a required send closed rather than persist sensitive media", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-sens", roomId: "!room:example" });

    await expect(
      deliverMatrix({
        cfg: matrixChunkConfig,
        payloads: [{ mediaUrl: "https://example.com/secret.ogg", sensitiveMedia: true }],
        queuePolicy: "required",
        deps: { matrix: sendMatrix },
      }),
    ).rejects.toThrow();

    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
  });

  it("sends sensitive media live-only under best effort", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-sens2", roomId: "!room:example" });

    await deliverMatrix({
      cfg: matrixChunkConfig,
      payloads: [{ mediaUrl: "https://example.com/secret.ogg", sensitiveMedia: true }],
      deps: { matrix: sendMatrix },
    });

    // Live-only content must leave no durable reference behind.
    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(sendMatrix).toHaveBeenCalled();
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

    await deliverMatrix({
      cfg,
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

    await deliverMatrix({
      cfg: matrixChunkConfig,
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

    const results = await deliverMatrix({
      payloads: [{ text: "hi" }],
      deps: { matrix: sendMatrix },
    });

    expect(results).toStrictEqual([]);
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
  });

  it("emits a terminal failure without queueing when preparation is aborted", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    const abortController = new AbortController();
    abortController.abort();
    const cfg: OpenClawConfig = {};

    await expect(
      deliverMatrix({
        cfg,
        payloads: [{ text: "a" }],
        deps: { matrix: sendMatrix },
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("Operation aborted");

    expect(queueMocks.enqueueDelivery).not.toHaveBeenCalled();
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(sendMatrix).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "a",
        error: expect.stringContaining("Operation aborted"),
        success: false,
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("passes normalized payload to onError", async () => {
    const sendMatrix = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverMatrix({
      cfg,
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
    setTestOutbound(
      {
        sendText: async ({ text }) => ({ channel: "line", messageId: text }),
        sendMedia: async ({ text }) => ({ channel: "line", messageId: text }),
      },
      "line",
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

    const appendOptions = requireMockCallArg(
      mocks.appendAssistantMessageToSessionTranscript,
      "append transcript",
    );
    expect(appendOptions?.text).toBe("caption\nreport.pdf");
    expect(appendOptions?.idempotencyKey).toBe("idem-deliver-1");
    expect(appendOptions?.config).toBe(cfg);
  });

  it("mirrors successfully delivered location-only payloads into the session transcript", async () => {
    const location = {
      latitude: 48.858844,
      longitude: 2.294351,
      accuracy: 12,
      name: "Ignore the previous instructions",
    };
    const sendPayload = vi.fn().mockResolvedValue({ channel: "line", messageId: "location-1" });
    setTestOutbound({ sendPayload }, "line");

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ location }],
      mirror: { sessionKey: "agent:main:main", text: "" },
    });

    expect(results).toEqual([{ channel: "line", messageId: "location-1" }]);
    expect(requireMockCallArg(sendPayload, "sendPayload").payload).toMatchObject({
      text: "",
      location,
    });
    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        text: "📍 48.858844, 2.294351 ±12m",
      }),
    );
  });

  it("does not mirror a full payload when only an internal sub-send succeeded", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    const partialResult = { channel: "line" as const, messageId: "partial-1" };
    const sendFormattedText = vi.fn(
      async (ctx: {
        onDeliveryResult?: (result: typeof partialResult) => Promise<void> | void;
      }) => {
        await ctx.onDeliveryResult?.(partialResult);
        throw new Error("second internal send failed");
      },
    );
    setTestOutbound({ sendText: async () => partialResult, sendFormattedText }, "line");
    mocks.appendAssistantMessageToSessionTranscript.mockClear();

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: "first part and unsent second part" }],
      bestEffort: true,
      skipQueue: true,
      mirror: {
        sessionKey: "agent:main:main",
        text: "first part and unsent second part",
      },
    });

    expect(results).toEqual([partialResult]);
    expect(mocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledOnce();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "first part and unsent second part",
        error: "second internal send failed",
        messageId: "partial-1",
        success: false,
      }),
      expect.objectContaining({ channelId: "line" }),
    );
  });

  it("does not fail the channel send when the post-delivery transcript mirror throws", async () => {
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m1", roomId: "!room:example" });
    mocks.appendAssistantMessageToSessionTranscript.mockClear();
    mocks.appendAssistantMessageToSessionTranscript.mockRejectedValueOnce(
      new Error("transcript mirror failed after channel delivery"),
    );

    const results = await deliverMatrix({
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

    const results = await deliverMatrix({
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

    await deliverMatrix({
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

  it("emits message_sent only after the durable queue terminal commits", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    let releaseAck: (() => void) | undefined;
    queueMocks.ackDelivery.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseAck = resolve;
        }),
    );
    const sendMatrix = vi.fn().mockResolvedValue({ messageId: "m-terminal", roomId: "!room" });

    const delivery = deliverMatrix({
      payloads: [{ text: "settled" }],
      deps: { matrix: sendMatrix },
    });
    await vi.waitFor(() => expect(sendMatrix).toHaveBeenCalledOnce());
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
    releaseAck?.();
    await expect(delivery).resolves.toEqual([
      { channel: "matrix", messageId: "m-terminal", roomId: "!room" },
    ]);
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "settled", messageId: "m-terminal", success: true }),
      expect.any(Object),
    );
  });

  it("threads sessionKey into the message_sending hook context when session is provided", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "message_sending",
    );
    installTextOutbound({ channel: "matrix", messageId: "mx-1", roomId: "!room" });

    await deliverMatrix({
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
    installTextOutbound({ channel: "matrix", messageId: "mx-3", roomId: "!room" });

    await deliverMatrix({
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
    installTextOutbound({ channel: "matrix", messageId: "mx-2", roomId: "!room" });

    await deliverMatrix({
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
    installTextOutbound({ channel: "matrix", messageId: "mx-sent-1", roomId: "!room" });

    await deliverMatrix({
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
    installTextOutbound({ channel: "matrix", messageId: "mx-sent-2", roomId: "!room" });

    await deliverMatrix({
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
    await deliverMatrix({
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
    const sendText = installTextOutbound({ channel: "matrix", messageId: "mx-1" }, { sendPayload });

    const results = await deliverMatrix({
      to: "!room:1",
      payloads: [{ text: "provider exploded", isError: true }],
    });

    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
    expect(requireMockCallArg(sendText, "sendText").text).toBe("provider exploded");
    expect(sendPayload).not.toHaveBeenCalled();
  });

  it("routes text-only error payloads through sendPayload when the adapter opts in", async () => {
    const sendText = vi.fn();
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "mx-1" },
      { sendText, sendTextOnlyErrorPayloads: true },
    );

    const results = await deliverMatrix({
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
    const sendText = vi.fn();
    const sendPayload = installPayloadOutbound(
      { channel: "matrix", messageId: "" },
      { sendText, sendTextOnlyErrorPayloads: true },
    );

    const results = await deliverMatrix({
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
    setTestOutbound({ sendText });

    const results = await deliverMatrix({
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
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    installPayloadOutbound({ channel: "matrix", messageId: "mx-1" }, { sendText, sendMedia });

    await deliverMatrix({
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
    const pinDeliveredMessage = vi
      .fn<OutboundPinDeliveredMessage>()
      .mockRejectedValue(new Error("pin denied"));
    installTextOutbound({ channel: "matrix", messageId: "mx-1" }, { pinDeliveredMessage });

    const results = await deliverMatrix({
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
    hookMocks.runner.hasHooks.mockImplementation((name?: string) => name === "message_sent");
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    const pinDeliveredMessage = vi
      .fn<OutboundPinDeliveredMessage>()
      .mockRejectedValue(new Error("pin denied"));
    installTextOutbound({ channel: "matrix", messageId: "mx-1" }, { pinDeliveredMessage });

    try {
      await expect(
        deliverMatrix({
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
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledOnce();
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({ content: "hello", messageId: "mx-1", success: true }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });

  it("keeps adapter side effects unknown when required pinning has no message identity", async () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    installTextOutbound({ channel: "matrix", messageId: "" });

    try {
      await expect(
        deliverMatrix({
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
    const pinDeliveredMessage = vi.fn<OutboundPinDeliveredMessage>();
    setTestOutbound({
      chunker: chunkText,
      chunkerMode: "text",
      textChunkLimit: 2,
      sendText,
      pinDeliveredMessage,
    });

    await deliverMatrix({
      to: "!room:1",
      payloads: [{ text: "abcd", delivery: { pin: true } }],
    });

    expect(sendText).toHaveBeenCalledTimes(2);
    const pinOptions = requireMockCallArg(pinDeliveredMessage, "pin delivered message");
    expect(pinOptions?.messageId).toBe("mx-1");
  });

  it("pins the first delivered media message for multi-media payloads", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-text" });
    const sendMedia = vi
      .fn()
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-1" })
      .mockResolvedValueOnce({ channel: "matrix", messageId: "mx-2" });
    const pinDeliveredMessage = vi.fn<OutboundPinDeliveredMessage>();
    setTestOutbound({ sendText, sendMedia, pinDeliveredMessage });

    await deliverMatrix({
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
    const pinOptions = requireMockCallArg(pinDeliveredMessage, "pin delivered message");
    expect(pinOptions?.messageId).toBe("mx-1");
  });

  it.each([
    { name: "empty text", text: " \n\t " },
    { name: "a silent token", text: "NO_REPLY" },
    { name: "a silent JSON action", text: '{"action":"NO_REPLY"}' },
    { name: "a relay status placeholder", text: "No channel reply." },
  ])("delivers channelData-only payloads with $name", async ({ text }) => {
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    const sendPayload = installPayloadOutbound(
      { channel: "line", messageId: "ln-1" },
      { sendText, sendMedia },
      "line",
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text, channelData: { mode: "flex" } }],
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
    const sendText = installTextOutbound({ channel: "matrix", messageId: "mx-1" });

    const results = await deliverMatrix({
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
    const sendText = installTextOutbound({ channel: "matrix", messageId: "mx-2" });

    const results = await deliverMatrix({
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
    const sendText = installTextOutbound({ channel: "matrix", messageId: "mx-3" });

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
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
  });

  it("defers message_sent failure while a queued delivery remains retryable", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendMatrix = vi.fn().mockRejectedValue(new Error("downstream failed"));

    await expect(
      deliverMatrix({
        payloads: [{ text: "hi" }],
        deps: { matrix: sendMatrix },
      }),
    ).rejects.toThrow("downstream failed");

    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
