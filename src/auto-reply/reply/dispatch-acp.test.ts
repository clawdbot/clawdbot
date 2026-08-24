import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpElicitationHandler } from "@openclaw/acp-core/runtime/types";
import { detectMime } from "@openclaw/media-core/mime";
// Tests ACP dispatch wiring, command bypass, and runtime event handling.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import type { MediaUnderstandingSkipError } from "../../../packages/media-understanding-common/src/errors.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import {
  configureChannelAdmissionEvidenceCollection,
  registerChannelAdmissionEvidenceOwner,
} from "../../channels/message-access/admission-evidence.js";
import { resolveStableChannelMessageIngress } from "../../channels/message-access/runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { ApplyMediaUnderstandingResult } from "../../media-understanding/apply.js";
import { isImageAttachment } from "../../media-understanding/attachments.normalize.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import {
  resolveAgentTurnAttachments,
  resolveInlineAgentImageAttachments,
} from "./agent-turn-attachments.js";
import { tryDispatchAcpReplyCore } from "./dispatch-acp.js";
import { createAbortAwareDispatcher } from "./dispatch-from-config.abort.js";
import {
  appendRecentHistoryImageContext,
  resolveRecentInboundHistoryImages,
} from "./history-media.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpSessionMeta,
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const auditMocks = vi.hoisted(() => ({
  emitAcpLifecycleStart: vi.fn(),
  emitAcpRuntimeEvent: vi.fn(),
  emitAcpLifecycleEnd: vi.fn(),
  emitAcpLifecycleError: vi.fn(),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn<
    (
      _params: unknown,
    ) => Promise<
      | { ok: true; delivered: boolean; messageId?: string }
      | { ok: true; delivered: false; suppressed: true }
      | { ok: false; delivered: boolean; error: string }
    >
  >(async () => ({ ok: true, delivered: true, messageId: "mock" })),
}));

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "discord" && channelId !== "slack" && channelId !== "telegram") {
      return undefined;
    }
    return {
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      outbound: {
        shouldTreatDeliveredTextAsVisible: ({
          kind,
          text,
        }: {
          kind: "tool" | "block" | "final";
          text?: string;
        }) => kind === "block" && typeof text === "string" && text.trim().length > 0,
      },
    };
  }),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));

const ttsCapabilityMocks = vi.hoisted(() => ({ captionedFinalText: false }));

const mediaUnderstandingMocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn<
    (_params: unknown) => Promise<ApplyMediaUnderstandingResult | undefined>
  >(async () => undefined),
}));

const acpAttachmentBuffers = vi.hoisted(() => new Map<string, Buffer>());
const ACP_PNG_IMAGE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const ACP_JPEG_IMAGE_BYTES = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const ACP_PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const ACP_ZIP_BYTES = Buffer.from("504b0506000000000000000000000000000000000000", "hex");

const diagnosticMocks = vi.hoisted(() => ({
  markDiagnosticSessionProgress: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn<
    (params: { sessionKey: string; cfg?: OpenClawConfig }) => AcpSessionStoreEntry | null
  >(() => null),
}));

const transcriptMocks = vi.hoisted(() => ({
  persistAcpDispatchTranscript: vi.fn(async (_params: unknown) => undefined),
}));

const bindingServiceMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
  unbind: vi.fn<(input: unknown) => Promise<SessionBindingRecord[]>>(async () => []),
}));

vi.mock("./dispatch-acp-manager.runtime.js", () => ({
  getAcpSessionManager: () => managerMocks,
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      bindingServiceMocks.listBySession(targetSessionKey),
    unbind: (input: unknown) => bindingServiceMocks.unbind(input),
  }),
}));

vi.mock("../../agents/command/attempt-execution.runtime.js", () => ({
  createAcpToolLifecycleTracker: () => ({
    active: new Map(),
    terminalToolCallIds: new Set(),
    saturated: false,
  }),
  emitAcpLifecycleStart: auditMocks.emitAcpLifecycleStart,
  emitAcpRuntimeEvent: auditMocks.emitAcpRuntimeEvent,
  emitAcpLifecycleEnd: auditMocks.emitAcpLifecycleEnd,
  emitAcpLifecycleError: auditMocks.emitAcpLifecycleError,
}));

vi.mock("../../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (cfg: OpenClawConfig) =>
    policyMocks.resolveAcpDispatchPolicyError(cfg),
  resolveAcpAgentPolicyError: (cfg: OpenClawConfig, agent: string) =>
    policyMocks.resolveAcpAgentPolicyError(cfg, agent),
}));

vi.mock("./route-reply.runtime.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  getLoadedChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
  normalizeChannelId: (channelId?: string | null) => channelId?.trim().toLowerCase() || null,
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("../../tts/captioned-final.js", async () => {
  const actual = await vi.importActual<typeof import("../../tts/captioned-final.js")>(
    "../../tts/captioned-final.js",
  );
  return {
    ...actual,
    shouldDeferFinalTtsText: () => ttsCapabilityMocks.captionedFinalText,
  };
});

vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));

vi.mock("./dispatch-acp-media.runtime.js", async () => {
  const attachmentNormalization = await vi.importActual<
    typeof import("../../media-understanding/attachments.normalize.js")
  >("../../media-understanding/attachments.normalize.js");
  return {
    applyMediaUnderstanding: (params: unknown) =>
      mediaUnderstandingMocks.applyMediaUnderstanding(params),
    isImageAttachment: attachmentNormalization.isImageAttachment,
    isMediaUnderstandingSkipError: (error: unknown): error is MediaUnderstandingSkipError =>
      error instanceof Error && error.name === "MediaUnderstandingSkipError",
    normalizeAttachments: attachmentNormalization.normalizeAttachments,
    resolveMediaAttachmentLocalRoots: (params: {
      cfg: { channels?: Record<string, { attachmentRoots?: string[] } | undefined> };
      ctx: { Provider?: string; Surface?: string };
    }) => {
      const channel = params.ctx.Provider ?? params.ctx.Surface ?? "";
      return params.cfg.channels?.[channel]?.attachmentRoots ?? [];
    },
    MediaAttachmentCache: class {
      constructor(
        private readonly attachments: Array<{ path?: string; mime?: string; index: number }>,
      ) {}
      async getBuffer({ attachmentIndex }: { attachmentIndex: number }) {
        const attachment = this.attachments.find((item) => item.index === attachmentIndex);
        const pathLocal = attachment?.path;
        const buffer = pathLocal ? acpAttachmentBuffers.get(pathLocal) : undefined;
        if (buffer) {
          return {
            buffer,
            mime: await detectMime({
              buffer,
              filePath: pathLocal,
              headerMime: attachment?.mime,
            }),
            fileName: pathLocal,
            size: buffer.length,
          };
        }
        const error = new Error("outside allowed roots");
        error.name = "MediaUnderstandingSkipError";
        throw error;
      }
    },
  };
});

vi.mock("../../logging/diagnostic.js", () => ({
  markDiagnosticSessionProgress: diagnosticMocks.markDiagnosticSessionProgress,
}));

vi.mock("./dispatch-acp-transcript.runtime.js", () => ({
  persistAcpDispatchTranscript: (params: unknown) =>
    transcriptMocks.persistAcpDispatchTranscript(params),
}));

const sessionKey = "agent:codex-acp:session-1";
const originalFetch = globalThis.fetch;
type MockTtsReply = Awaited<ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

const requireRecord = createRequireRecord("object", "expected-label");

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, _label: string) {
  return source.mock.calls[callIndex]?.[argIndex];
}

function routeCall(index = 0) {
  return requireRecord(
    mockArg(routeMocks.routeReply, index, 0, `route call ${index}`),
    "route call",
  );
}

function routePayload(index = 0) {
  return requireRecord(routeCall(index).payload, `route payload ${index}`);
}

function messageActionCall(index = 0) {
  return requireRecord(
    mockArg(messageActionMocks.runMessageAction, index, 0, `message action ${index}`),
    "message action",
  );
}

function runTurnCall(index = 0) {
  return requireRecord(mockArg(managerMocks.runTurn, index, 0, `run turn ${index}`), "run turn");
}

function dispatcherCall(
  fn:
    | ReplyDispatcher["sendToolResult"]
    | ReplyDispatcher["sendBlockReply"]
    | ReplyDispatcher["sendFinalReply"],
  index = 0,
) {
  return requireRecord(
    mockArg(fn as unknown as MockCallSource, index, 0, `dispatcher call ${index}`),
    "dispatcher call",
  );
}

function setReadyAcpResolution() {
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: createAcpSessionMeta(),
  });
}

function createAcpConfigWithVisibleToolTags(): OpenClawConfig {
  return createAcpTestConfig({
    acp: {
      enabled: true,
      stream: {
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

async function runDispatch(params: {
  bodyForAgent: string;
  runId?: string;
  cfg?: OpenClawConfig;
  dispatcher?: ReplyDispatcher;
  shouldRouteToOriginating?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  onReplyStart?: () => void;
  images?: Array<{ data: string; mimeType: string }>;
  abortSignal?: AbortSignal;
  ctxOverrides?: Record<string, unknown>;
  sessionKeyOverride?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  toolsAllow?: string[];
  recordProcessed?: (
    outcome: "completed" | "skipped" | "error",
    opts?: { reason?: string; error?: string },
  ) => void;
  markIdle?: (reason: string) => void;
  ctx?: FinalizedRuntimeMsgContext;
}) {
  const targetSessionKey = params.sessionKeyOverride ?? sessionKey;
  return tryDispatchAcpReplyCore({
    ctx:
      params.ctx ??
      buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: targetSessionKey,
        BodyForAgent: params.bodyForAgent,
        ...params.ctxOverrides,
      }),
    cfg: params.cfg ?? createAcpTestConfig(),
    dispatcher: params.dispatcher ?? createDispatcher().dispatcher,
    ...(params.runId ? { runId: params.runId } : {}),
    sessionKey: targetSessionKey,
    images: params.images,
    abortSignal: params.abortSignal,
    inboundAudio: false,
    suppressUserDelivery: params.suppressUserDelivery,
    suppressReplyLifecycle: params.suppressReplyLifecycle,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    shouldRouteToOriginating: params.shouldRouteToOriginating ?? false,
    ...(params.shouldRouteToOriginating
      ? {
          originatingChannel: params.originatingChannel ?? "telegram",
          originatingTo: params.originatingTo ?? "telegram:thread-1",
        }
      : {}),
    shouldSendToolSummaries: true,
    shouldSendFullToolDetails: false,
    bypassForCommand: false,
    toolsAllow: params.toolsAllow,
    ...(params.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
    recordProcessed: params.recordProcessed ?? vi.fn(),
    markIdle: params.markIdle ?? vi.fn(),
  });
}

async function emitToolLifecycleEvents(
  onEvent: (event: unknown) => Promise<void>,
  toolCallId: string,
) {
  await onEvent({
    type: "tool_call",
    tag: "tool_call",
    toolCallId,
    status: "in_progress",
    title: "Run command",
    text: "Run command (in_progress)",
  });
  await onEvent({
    type: "tool_call",
    tag: "tool_call_update",
    toolCallId,
    status: "completed",
    title: "Run command",
    text: "Run command (completed)",
  });
  await onEvent({ type: "done" });
}

function mockToolLifecycleTurn(toolCallId: string) {
  managerMocks.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await emitToolLifecycleEvents(onEvent, toolCallId);
    },
  );
}

function mockVisibleTextTurn(text = "visible") {
  managerMocks.runTurn.mockImplementationOnce(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
      await onEvent({ type: "done" });
    },
  );
}

function mockRoutedTextTurn(text: string) {
  managerMocks.runTurn.mockImplementation(
    async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
      await onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
      await onEvent({ type: "done" });
    },
  );
}

async function dispatchVisibleTurn(onReplyStart: () => void) {
  await runDispatch({
    bodyForAgent: "visible",
    dispatcher: createDispatcher().dispatcher,
    onReplyStart,
  });
}

function queueTtsReplies(...replies: MockTtsReply[]) {
  for (const reply of replies) {
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce(reply);
  }
}

async function runRoutedAcpTextTurn(text: string) {
  mockRoutedTextTurn(text);
  const { dispatcher } = createDispatcher();
  const result = await runDispatch({
    bodyForAgent: "run acp",
    dispatcher,
    shouldRouteToOriginating: true,
  });
  return { result };
}

function expectRoutedPayload(callIndex: number, payload: Partial<MockTtsReply>) {
  const routedPayload = routePayload(callIndex - 1);
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    expect(routedPayload[key]).toEqual(value);
  }
}

describe("tryDispatchAcpReplyCore", () => {
  beforeEach(() => {
    auditMocks.emitAcpLifecycleStart.mockReset();
    auditMocks.emitAcpRuntimeEvent.mockReset();
    auditMocks.emitAcpLifecycleEnd.mockReset();
    auditMocks.emitAcpLifecycleError.mockReset();
    managerMocks.resolveSession.mockReset();
    managerMocks.runTurn.mockReset();
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent?: (event: unknown) => Promise<void> }) => {
        await onEvent?.({ type: "done" });
      },
    );
    managerMocks.getObservabilitySnapshot.mockReset();
    managerMocks.getObservabilitySnapshot.mockReturnValue({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 0 },
    });
    policyMocks.resolveAcpDispatchPolicyError.mockReset();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(null);
    policyMocks.resolveAcpAgentPolicyError.mockReset();
    policyMocks.resolveAcpAgentPolicyError.mockReturnValue(null);
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({
      ok: true,
      delivered: true,
      messageId: "mock",
    });
    channelPluginMocks.getChannelPlugin.mockClear();
    messageActionMocks.runMessageAction.mockReset();
    messageActionMocks.runMessageAction.mockResolvedValue({ ok: true as const });
    ttsMocks.maybeApplyTtsToPayload.mockReset();
    ttsMocks.maybeApplyTtsToPayload.mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as { payload: unknown };
      return params.payload;
    });
    ttsMocks.resolveTtsConfig.mockReset();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    ttsCapabilityMocks.captionedFinalText = false;
    mediaUnderstandingMocks.applyMediaUnderstanding.mockReset();
    mediaUnderstandingMocks.applyMediaUnderstanding.mockResolvedValue(undefined);
    acpAttachmentBuffers.clear();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReset();
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue(null);
    transcriptMocks.persistAcpDispatchTranscript.mockClear();
    bindingServiceMocks.listBySession.mockReset();
    bindingServiceMocks.listBySession.mockReturnValue([]);
    bindingServiceMocks.unbind.mockReset();
    bindingServiceMocks.unbind.mockResolvedValue([]);
    globalThis.fetch = originalFetch;
  });

  it("admits ACP message turns with the original channel participant", async () => {
    const captured: unknown[] = [];
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    const owner = { channelId: "discord", record: {}, epoch: {}, isLive: () => true };
    const clearOwner = registerChannelAdmissionEvidenceOwner(owner);
    try {
      setReadyAcpResolution();
      const channelIngress = await resolveStableChannelMessageIngress({
        channelId: "discord",
        accountId: "default",
        subject: { stableId: "person-42" },
        conversation: { kind: "group", id: "room-1" },
        contextBinding: {
          agentId: "main",
          sessionKey,
          messageId: "msg-acp",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
        groupPolicy: "open",
      });
      const buildContext = createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      );
      const ctx = finalizeInboundContext(
        await buildContext({
          channel: "discord",
          accountId: "default",
          messageId: "msg-acp",
          from: "discord:channel:room-1",
          sender: { id: "person-42" },
          conversation: { kind: "group", id: "room-1" },
          route: { agentId: "main", routeSessionKey: sessionKey },
          reply: { to: "discord:channel:room-1" },
          message: { rawBody: "run acp", bodyForAgent: "run acp" },
          channelIngress,
        }),
      );

      await runDispatch({
        bodyForAgent: "run acp",
        cfg: createAcpTestConfig({ logging: { audit: { executionIdentity: true } } }),
        ctx,
      });

      expect(captured).toMatchObject([
        {
          kind: "capture",
          envelope: {
            ingress: { kind: "acp", state: "present" },
            invoker: { state: "present", kind: "person" },
          },
        },
      ]);
    } finally {
      clearOwner();
      clearSink();
      clearCollection();
    }
  });

  it("passes one turn-scoped elicitation handler and fences it after admission closes", async () => {
    setReadyAcpResolution();
    let onElicitation: AcpElicitationHandler | undefined;
    managerMocks.runTurn.mockImplementationOnce(async (input: unknown) => {
      const turn = input as {
        onElicitation?: typeof onElicitation;
        onEvent?: (event: unknown) => Promise<void>;
      };
      onElicitation = turn.onElicitation;
      await turn.onEvent?.({ type: "done" });
    });

    await runDispatch({ bodyForAgent: "ask me" });

    expect(onElicitation).toBeTypeOf("function");
    const response = await onElicitation!(
      {
        mode: "url",
        sessionId: "acp-session",
        message: "Continue",
        elicitationId: "url-1",
        url: "https://example.com",
      },
      { requestId: "rpc-1", signal: new AbortController().signal },
    );
    expect(response.action).toBe("cancel");
  });

  it.each([
    { name: "canonical", requestedSessionKey: sessionKey, resolvedSessionKey: sessionKey },
    {
      name: "legacy",
      requestedSessionKey: "agent:legacy-acp:private-session",
      resolvedSessionKey: sessionKey,
    },
  ] as const)(
    "records one owner-bound unsupported native-action receipt after $name ACP admission",
    async ({ requestedSessionKey, resolvedSessionKey }) => {
      const ordering: string[] = [];
      const receipts: DecisionReceiptV1[] = [];
      const clearAdmission = configureExecutionIdentityAdmissionSink(() => {
        ordering.push("admission");
        return true;
      });
      const clearDecision = configureRuntimeActionDecisionSink((receipt) => {
        ordering.push("decision");
        receipts.push(receipt);
        return true;
      });
      managerMocks.resolveSession.mockReturnValue({
        kind: "ready",
        sessionKey: resolvedSessionKey,
        meta: createAcpSessionMeta({ agent: "private-agent-must-not-leak" }),
      });
      managerMocks.runTurn.mockImplementationOnce(
        async ({
          onLifecycle,
          onEvent,
        }: {
          onLifecycle?: (event: { type: "prompt_submitted"; at: number }) => void;
          onEvent?: (event: unknown) => Promise<void>;
        }) => {
          onLifecycle?.({ type: "prompt_submitted", at: 101 });
          onLifecycle?.({ type: "prompt_submitted", at: 102 });
          await onEvent?.({
            type: "tool_call",
            toolCallId: "private-tool-call",
            title: "adapter-private-marker",
          });
          await onEvent?.({ type: "done" });
        },
      );

      try {
        await runDispatch({
          bodyForAgent: "private prompt must not leak",
          cfg: createAcpTestConfig({ logging: { audit: { executionIdentity: true } } }),
          sessionKeyOverride: requestedSessionKey,
        });
      } finally {
        clearDecision();
        clearAdmission();
      }

      const admittedToken = requireRecord(
        requireRecord(runTurnCall().admittedRunContext, "admitted run context")
          .executionIdentityToken,
        "execution identity token",
      );
      expect(ordering).toEqual(["admission", "decision"]);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        contextId: admittedToken.contextId,
        executionId: admittedToken.executionId,
        runId: admittedToken.runId,
        action: {
          family: "native-runtime",
          operation: "action-evidence",
          summary:
            "ACP runtime action evidence is unsupported because the adapter exposes no authoritative native-action callback.",
        },
        decision: {
          outcome: "not-applicable",
          reasonCode: "native_action_callback_unsupported",
        },
        enforcement: {
          coverageState: "unsupported",
          evaluatorRef: "acp-runtime",
        },
        source: {
          owner: "acp-runtime",
          decisionBoundary: "acp-runtime.prompt-submitted",
        },
        missingEvidence: ["native.action_callback"],
        remediation: [
          {
            code: "instrument_native_action_callback",
            text: "Instrument an authoritative native-action callback in the ACP adapter before claiming action evidence.",
          },
        ],
      });
      const serialized = JSON.stringify(receipts);
      expect(serialized.length).toBeLessThan(2_048);
      expect(serialized).not.toContain(requestedSessionKey);
      expect(serialized).not.toContain("private-session");
      expect(serialized).not.toContain("private-agent-must-not-leak");
      expect(serialized).not.toContain("private prompt must not leak");
      expect(serialized).not.toContain("private-tool-call");
      expect(serialized).not.toContain("adapter-private-marker");
    },
  );

  it("keeps ACP native-action evidence one-shot after abort and terminal lifecycle", async () => {
    const receipts: DecisionReceiptV1[] = [];
    const clearAdmission = configureExecutionIdentityAdmissionSink(() => true);
    const clearDecision = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const controller = new AbortController();
    let replayLifecycle: (() => void) | undefined;
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementationOnce(
      async ({
        onLifecycle,
        onEvent,
      }: {
        onLifecycle?: (event: { type: "prompt_submitted"; at: number }) => void;
        onEvent?: (event: unknown) => Promise<void>;
      }) => {
        replayLifecycle = () => onLifecycle?.({ type: "prompt_submitted", at: 201 });
        replayLifecycle();
        controller.abort();
        replayLifecycle();
        await onEvent?.({ type: "done", status: "cancelled" });
      },
    );

    try {
      await runDispatch({
        bodyForAgent: "abort",
        abortSignal: controller.signal,
        cfg: createAcpTestConfig({ logging: { audit: { executionIdentity: true } } }),
      });
      replayLifecycle?.();
    } finally {
      clearDecision();
      clearAdmission();
    }

    expect(receipts).toHaveLength(1);
  });

  it("uses the current sink after replacement for each ACP dispatch closure", async () => {
    const replacedReceipts: DecisionReceiptV1[] = [];
    const currentReceipts: DecisionReceiptV1[] = [];
    const clearAdmission = configureExecutionIdentityAdmissionSink(() => true);
    const clearReplaced = configureRuntimeActionDecisionSink((receipt) => {
      replacedReceipts.push(receipt);
      return true;
    });
    const clearCurrent = configureRuntimeActionDecisionSink((receipt) => {
      currentReceipts.push(receipt);
      return true;
    });
    clearReplaced();
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(
      async ({
        onLifecycle,
        onEvent,
      }: {
        onLifecycle?: (event: { type: "prompt_submitted"; at: number }) => void;
        onEvent?: (event: unknown) => Promise<void>;
      }) => {
        onLifecycle?.({ type: "prompt_submitted", at: 301 });
        await onEvent?.({ type: "done" });
      },
    );

    try {
      const cfg = createAcpTestConfig({ logging: { audit: { executionIdentity: true } } });
      await runDispatch({ bodyForAgent: "first", cfg });
      await runDispatch({ bodyForAgent: "replacement", cfg });
    } finally {
      clearCurrent();
      clearAdmission();
    }

    expect(replacedReceipts).toHaveLength(0);
    expect(currentReceipts).toHaveLength(2);
    expect(currentReceipts[0]?.contextId).not.toBe(currentReceipts[1]?.contextId);
  });

  it("keeps ACP dispatch fail-open when no runtime-action sink is installed", async () => {
    const clearAdmission = configureExecutionIdentityAdmissionSink(() => true);
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementationOnce(
      async ({
        onLifecycle,
        onEvent,
      }: {
        onLifecycle?: (event: { type: "prompt_submitted"; at: number }) => void;
        onEvent?: (event: unknown) => Promise<void>;
      }) => {
        onLifecycle?.({ type: "prompt_submitted", at: 401 });
        await onEvent?.({ type: "done" });
      },
    );

    try {
      await expect(
        runDispatch({
          bodyForAgent: "no sink",
          cfg: createAcpTestConfig({ logging: { audit: { executionIdentity: true } } }),
        }),
      ).resolves.toEqual(expect.objectContaining({ queuedFinal: false }));
    } finally {
      clearAdmission();
    }
  });

  it("projects normal ACP dispatch lifecycle and tool events into audit diagnostics", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("tool-audit");

    await runDispatch({ bodyForAgent: "audit this turn" });

    expect(auditMocks.emitAcpLifecycleStart).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        sessionKey,
        startedAt: expect.any(Number),
        auditOnly: true,
      }),
    );
    expect(auditMocks.emitAcpRuntimeEvent).toHaveBeenCalledTimes(3);
    expect(auditMocks.emitAcpRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.any(String),
        sessionKey,
        auditOnly: true,
        event: expect.objectContaining({ type: "tool_call", toolCallId: "tool-audit" }),
      }),
    );
    expect(auditMocks.emitAcpLifecycleEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: expect.any(String), sessionKey, auditOnly: true }),
    );
    expect(auditMocks.emitAcpLifecycleError).not.toHaveBeenCalled();
  });

  it("keeps caller-owned run ids on the shared lifecycle path", async () => {
    setReadyAcpResolution();

    await runDispatch({ bodyForAgent: "audit this turn", runId: "caller-run" });

    expect(auditMocks.emitAcpLifecycleStart).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "caller-run", auditOnly: false }),
    );
    expect(auditMocks.emitAcpLifecycleEnd).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "caller-run", auditOnly: false }),
    );
  });

  it("keeps audit run ids unique when channel message ids repeat", async () => {
    setReadyAcpResolution();

    await runDispatch({
      bodyForAgent: "first turn",
      ctxOverrides: { MessageSid: "channel-local-1" },
    });
    await runDispatch({
      bodyForAgent: "second turn",
      ctxOverrides: { MessageSid: "channel-local-1" },
    });

    const auditRunIds = [0, 1].map(
      (index) =>
        requireRecord(
          mockArg(auditMocks.emitAcpLifecycleStart, index, 0, `audit start ${index}`),
          "audit start",
        ).runId,
    );
    expect(new Set(auditRunIds).size).toBe(2);
    expect([runTurnCall(0).requestId, runTurnCall(1).requestId]).toEqual([
      "channel-local-1",
      "channel-local-1",
    ]);
  });

  it("routes default ACP output to the originating channel as a final reply", async () => {
    setReadyAcpResolution();
    mockRoutedTextTurn("hello");

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(1);
    expect(routeCall().channel).toBe("telegram");
    expect(routeCall().to).toBe("telegram:thread-1");
    expect(routePayload().text).toBe("hello");
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("records channel transform suppression without an ACP delivery claim", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("private reply");
    const transport = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      deliver: transport,
      transformReplyPayload: () => null,
    });
    const recordProcessed = vi.fn();

    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      recordProcessed,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(transport).not.toHaveBeenCalled();
    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(recordProcessed).toHaveBeenCalledWith("completed", {
      reason: "channel_transform",
    });
    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(transcript.finalText).toBe("");
  });

  it("persists ACP transcript when routed delivery fails", async () => {
    setReadyAcpResolution();
    mockRoutedTextTurn("hello");
    routeMocks.routeReply.mockResolvedValue({
      ok: false,
      delivered: false,
      error: "missing channel adapter",
    });

    await runDispatch({
      bodyForAgent: "reply",
      shouldRouteToOriginating: true,
    });

    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(transcript.sessionKey).toBe(sessionKey);
    expect(transcript.promptText).toBe("reply");
    expect(transcript.finalText).toBe("hello");
    expect(routeCall().mirror).toBe(false);
  });

  it("persists the failed turn so the bound transcript matches the channel reply", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(async () => {
      throw new Error("acp exploded mid-turn");
    });

    await runDispatch({ bodyForAgent: "reply" });

    // A failed bound turn used to deliver an error to the channel while writing
    // nothing to the transcript, so the next resume replayed history that never
    // mentioned the failure.
    expect(transcriptMocks.persistAcpDispatchTranscript).toHaveBeenCalledTimes(1);
    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(transcript.sessionKey).toBe(sessionKey);
    expect(transcript.promptText).toBe("reply");
    expect(String(transcript.finalText)).toContain("acp exploded mid-turn");
  });

  it("keeps streamed output ahead of the error when a turn fails mid-stream", async () => {
    setReadyAcpResolution();
    managerMocks.runTurn.mockImplementation(async (params: unknown) => {
      const handler = params as { onEvent?: (event: unknown) => void };
      handler.onEvent?.({ type: "text_delta", stream: "output", text: "partial answer" });
      throw new Error("acp died after streaming");
    });

    await runDispatch({ bodyForAgent: "reply" });

    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(String(transcript.finalText)).toContain("partial answer");
    expect(String(transcript.finalText)).toContain("acp died after streaming");
  });

  it("preserves an intentionally empty canonical agent prompt", async () => {
    setReadyAcpResolution();

    await runDispatch({
      bodyForAgent: "",
      ctxOverrides: { BodyForCommands: "/status", CommandBody: "/status" },
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
  });

  it("adds source delivery guidance to tool-only ACP turns", async () => {
    setReadyAcpResolution();

    await runDispatch({
      bodyForAgent: "reply privately unless you send explicitly",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(managerMocks.runTurn).toHaveBeenCalledTimes(1);
    const text = runTurnCall().text;
    expect(text).toContain("Source channel delivery is private by default");
    expect(text).toContain("message(action=send)");
    expect(text).toContain("The target defaults to the current source channel");
    expect(text).toContain("reply privately unless you send explicitly");
  });

  it("starts reply lifecycle for tool-only ACP turns while suppressing automatic delivery", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("hidden final");
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    const result = await runDispatch({
      bodyForAgent: "reply via message tool if needed",
      dispatcher,
      onReplyStart,
      suppressUserDelivery: true,
      suppressReplyLifecycle: false,
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(result?.queuedFinal).toBe(false);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("keeps same-provider tool-only ACP final replies private when an origin route exists", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("hidden final");
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    const result = await runDispatch({
      bodyForAgent: "reply via message tool if needed",
      dispatcher,
      onReplyStart,
      suppressUserDelivery: true,
      suppressReplyLifecycle: false,
      sourceReplyDeliveryMode: "message_tool_only",
      shouldRouteToOriginating: true,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
    });

    expect(result?.queuedFinal).toBe(false);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("edits ACP tool lifecycle updates in place when supported", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("call-1");
    routeMocks.routeReply.mockResolvedValueOnce({
      ok: true,
      delivered: true,
      messageId: "tool-msg-1",
    });

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "run tool",
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(messageActionCall().action).toBe("edit");
    expect(requireRecord(messageActionCall().params, "message action params").messageId).toBe(
      "tool-msg-1",
    );
  });

  it("falls back to new tool message when edit fails", async () => {
    setReadyAcpResolution();
    mockToolLifecycleTurn("call-2");
    routeMocks.routeReply
      .mockResolvedValueOnce({ ok: true, delivered: true, messageId: "tool-msg-2" })
      .mockResolvedValueOnce({
        ok: true,
        delivered: true,
        messageId: "tool-msg-2-fallback",
      });
    messageActionMocks.runMessageAction.mockRejectedValueOnce(new Error("edit unsupported"));

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "run tool",
      cfg: createAcpConfigWithVisibleToolTags(),
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(messageActionMocks.runMessageAction).toHaveBeenCalledTimes(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle when ACP turn starts, including hidden-only turns", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "status",
          tag: "usage_update",
          text: "usage updated: 1/100",
          used: 1,
          size: 100,
        });
        await onEvent({ type: "done" });
      },
    );
    await runDispatch({
      bodyForAgent: "hidden",
      dispatcher,
      onReplyStart,
    });
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    mockVisibleTextTurn();
    await dispatchVisibleTurn(onReplyStart);
    expect(onReplyStart).toHaveBeenCalledTimes(2);
  });

  it("starts reply lifecycle once per turn when output is delivered", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();

    mockVisibleTextTurn();
    await dispatchVisibleTurn(onReplyStart);

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not mark ACP diagnostic progress when diagnostics are disabled", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn();

    await runDispatch({
      bodyForAgent: "visible",
      cfg: createAcpTestConfig({ diagnostics: { enabled: false } }),
    });

    expect(diagnosticMocks.markDiagnosticSessionProgress).not.toHaveBeenCalled();
  });

  it("does not start reply lifecycle for empty ACP prompt", async () => {
    setReadyAcpResolution();
    const onReplyStart = vi.fn();
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "   ",
      dispatcher,
      onReplyStart,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(onReplyStart).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleStart).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleEnd).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleError).not.toHaveBeenCalled();
  });

  it("persists delivered ACP output for backend cancellation without a caller abort", async () => {
    setReadyAcpResolution();
    const deliveredPayloads: unknown[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveredPayloads.push(payload);
      },
    });
    const recordProcessed = vi.fn();
    const markIdle = vi.fn();
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "partial", tag: "agent_message_chunk" });
        await onEvent({ type: "done", status: "cancelled", stopReason: "cancelled" });
      },
    );

    const result = await runDispatch({
      bodyForAgent: "cancel this turn",
      dispatcher,
      recordProcessed,
      markIdle,
    });

    expect(result?.queuedFinal).toBe(true);
    expect(deliveredPayloads).toEqual([{ text: "partial" }]);
    expect(transcriptMocks.persistAcpDispatchTranscript).toHaveBeenCalledTimes(1);
    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(transcript.sessionKey).toBe(sessionKey);
    expect(transcript.promptText).toBe("cancel this turn");
    expect(transcript.finalText).toBe("partial");
    expect(recordProcessed).toHaveBeenCalledWith("completed", { reason: "acp_aborted" });
    expect(markIdle).toHaveBeenCalledWith("message_aborted");
    expect(transcriptMocks.persistAcpDispatchTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      recordProcessed.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(auditMocks.emitAcpLifecycleEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        resultStatus: "cancelled",
      }),
    );
    expect(auditMocks.emitAcpLifecycleError).not.toHaveBeenCalled();
  });

  it("does not persist final-only output rejected after caller cancellation", async () => {
    setReadyAcpResolution();
    const abortController = new AbortController();
    const base = createDispatcher();
    const dispatcher = createAbortAwareDispatcher({
      dispatcher: base.dispatcher,
      isAborted: () => abortController.signal.aborted,
    });
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "not delivered", tag: "agent_message_chunk" });
        abortController.abort();
        await onEvent({ type: "done", status: "cancelled" });
      },
    );

    const result = await runDispatch({
      bodyForAgent: "cancel before delivery",
      abortSignal: abortController.signal,
      dispatcher,
    });

    expect(result?.queuedFinal).toBe(false);
    expect(base.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(transcript.promptText).toBe("cancel before delivery");
    expect(transcript.finalText).toBe("");
  });

  it("persists live ACP output delivered before caller cancellation", async () => {
    setReadyAcpResolution();
    const abortController = new AbortController();
    const deliveredPayloads: Array<Record<string, unknown>> = [];
    let markDeliveryStarted!: () => void;
    let releaseDelivery!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const coreDispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        deliveredPayloads.push(requireRecord(payload, "delivered payload"));
        markDeliveryStarted();
        await deliveryGate;
      },
    });
    const dispatcher = createAbortAwareDispatcher({
      dispatcher: coreDispatcher,
      isAborted: () => abortController.signal.aborted,
    });
    const partial = "Visible before cancellation. ".repeat(4);
    let markTurnReady!: () => void;
    let finishTurn!: () => void;
    let markTurnDone!: () => void;
    const turnReady = new Promise<void>((resolve) => {
      markTurnReady = resolve;
    });
    const finishTurnGate = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const turnDone = new Promise<void>((resolve) => {
      markTurnDone = resolve;
    });
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: partial, tag: "agent_message_chunk" });
        markTurnReady();
        await finishTurnGate;
        await onEvent({ type: "done", status: "cancelled" });
        markTurnDone();
      },
    );

    const dispatchPromise = runDispatch({
      bodyForAgent: "cancel after delivery",
      abortSignal: abortController.signal,
      cfg: createAcpTestConfig({
        acp: {
          enabled: true,
          stream: { deliveryMode: "live" },
        },
      }),
      dispatcher,
    });

    await turnReady;
    await deliveryStarted;
    abortController.abort();
    finishTurn();
    await turnDone;
    const earlyOutcome = await Promise.race([
      dispatchPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 10);
      }),
    ]);
    expect(earlyOutcome).toBe("pending");
    expect(transcriptMocks.persistAcpDispatchTranscript).not.toHaveBeenCalled();

    releaseDelivery();
    await dispatchPromise;

    const deliveredText = deliveredPayloads.map((payload) => String(payload.text)).join("\n");
    expect(deliveredText).not.toBe("");
    expect(partial).toContain(deliveredText.replaceAll("\n", ""));
    const transcript = requireRecord(
      mockArg(transcriptMocks.persistAcpDispatchTranscript, 0, 0, "transcript call"),
      "transcript call",
    );
    expect(transcript.finalText).toBe(deliveredText.trimEnd());
  });

  it("keeps caller abort authoritative until completed output settles", async () => {
    setReadyAcpResolution();
    const abortController = new AbortController();
    const { dispatcher } = createDispatcher();
    const recordProcessed = vi.fn();
    const markIdle = vi.fn();
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "complete", tag: "agent_message_chunk" });
        await onEvent({ type: "done", status: "completed" });
        abortController.abort();
      },
    );

    const result = await runDispatch({
      bodyForAgent: "finish first",
      abortSignal: abortController.signal,
      dispatcher,
      recordProcessed,
      markIdle,
    });

    expect(result?.queuedFinal).toBe(true);
    expect(recordProcessed).toHaveBeenCalledWith("completed", { reason: "acp_aborted" });
    expect(markIdle).toHaveBeenCalledWith("message_aborted");
    expect(auditMocks.emitAcpLifecycleEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
        resultStatus: "completed",
      }),
    );
  });

  it("records an ACP error when output finalization fails", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("visible output");
    const { dispatcher } = createDispatcher();
    vi.mocked(dispatcher.waitForIdle)
      .mockRejectedValueOnce(new Error("output settlement failed"))
      .mockResolvedValue(undefined);

    await runDispatch({
      bodyForAgent: "finalize this turn",
      dispatcher,
    });

    expect(auditMocks.emitAcpLifecycleEnd).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: "output settlement failed" }),
      }),
    );
  });

  it("skips media understanding for text-only ACP turns", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("text only");

    await runDispatch({
      bodyForAgent: "plain text prompt",
    });

    expect(mediaUnderstandingMocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("skips media understanding for cached stickers while preserving their attachment", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("cached sticker");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const stickerPath = path.join(tempDir, "sticker.webp");
    try {
      await fs.writeFile(stickerPath, "image-bytes");

      await runDispatch({
        bodyForAgent: "[Sticker] Cached description",
        ctxOverrides: {
          MediaPath: stickerPath,
          MediaPaths: [stickerPath],
          MediaType: "image/webp",
          MediaTypes: ["image/webp"],
          Sticker: { cachedDescription: "Cached description" },
          StickerMediaIncluded: true,
          SkipStickerMediaUnderstanding: true,
        },
      });

      expect(mediaUnderstandingMocks.applyMediaUnderstanding).not.toHaveBeenCalled();
      expect(managerMocks.runTurn).toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes the ACP agent directory without declaring host-path access", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("image turn");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const agentDir = path.join(tempDir, "codex-agent");
    const imagePath = path.join(tempDir, "inbound.png");
    try {
      await fs.mkdir(agentDir);
      await fs.writeFile(imagePath, "image-bytes");

      await runDispatch({
        bodyForAgent: "describe image",
        cfg: createAcpTestConfig({
          agents: {
            list: [{ id: "codex-acp", agentDir }],
          },
          channels: {
            imessage: {
              attachmentRoots: [tempDir],
            },
          },
        }),
        ctxOverrides: {
          Provider: "imessage",
          Surface: "imessage",
          MediaPath: imagePath,
          MediaType: "image/png",
        },
      });

      const mediaUnderstandingParams = requireRecord(
        mockArg(mediaUnderstandingMocks.applyMediaUnderstanding, 0, 0, "media understanding"),
        "media understanding",
      );
      expect(mediaUnderstandingParams.agentDir).toBe(agentDir);
      expect(mediaUnderstandingParams.selfServeLocalPaths).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("passes exactly the resolved attachment indexes as delivered images", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("image turn");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "delivered.png");
    try {
      // Real PNG bytes: the turn-attachment resolver byte-sniffs image MIME
      // through the harness buffer map keyed by local path.
      await fs.writeFile(imagePath, ACP_PNG_IMAGE_BYTES);
      acpAttachmentBuffers.set(imagePath, ACP_PNG_IMAGE_BYTES);

      await runDispatch({
        bodyForAgent: "describe both images",
        cfg: createAcpTestConfig({
          channels: {
            imessage: {
              attachmentRoots: [tempDir],
            },
          },
        }),
        ctxOverrides: {
          Provider: "imessage",
          Surface: "imessage",
          media: [
            { path: imagePath, contentType: "image/png", kind: "image" },
            { url: "https://cdn.example.test/photos/remote.png", contentType: "image/png" },
          ],
        },
      });

      // The delivered set must mirror the resolver: local image in, remote-url
      // image out — an empty or over-broad set reintroduces false skip claims.
      const delivered = requireRecord(
        mockArg(mediaUnderstandingMocks.applyMediaUnderstanding, 0, 0, "media understanding"),
        "media understanding",
      ).deliveredImageIndexes as ReadonlySet<number>;
      expect(delivered.has(0)).toBe(true);
      expect(delivered.has(1)).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("selects bounded recent local history images", () => {
    const now = 1_700_000_000_000;
    const ctx = buildTestCtx({
      Timestamp: now,
      InboundHistory: [
        {
          sender: "Old",
          body: "<media:image>",
          timestamp: now - 31 * 60_000,
          messageId: "old",
          media: [{ path: "/tmp/old.png", contentType: "image/png", kind: "image" }],
        },
        {
          sender: "Doc",
          body: "<media:document>",
          timestamp: now - 1_000,
          messageId: "doc",
          media: [{ path: "/tmp/doc.pdf", contentType: "application/pdf", kind: "document" }],
        },
        {
          sender: "Remote",
          body: "<media:image>",
          timestamp: now - 1_000,
          messageId: "remote",
          media: [
            { path: "https://example.com/image.png", contentType: "image/png", kind: "image" },
          ],
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          sender: `Recent ${index}`,
          body: "<media:image>",
          timestamp: now - (5 - index) * 1_000,
          messageId: `recent-${index}`,
          media: [
            { path: `/tmp/recent-${index}.png`, contentType: "image/png", kind: "image" as const },
          ],
        })),
        {
          sender: "Windows",
          body: "<media:image>",
          timestamp: now - 500,
          messageId: "windows",
          media: [
            {
              path: "C:\\Users\\Alice\\Pictures\\recent.png",
              contentType: "image/png",
              kind: "image",
            },
          ],
        },
      ],
    });

    expect(resolveRecentInboundHistoryImages({ ctx, isImageAttachment })).toEqual([
      {
        path: "/tmp/recent-2.png",
        contentType: "image/png",
        kind: "image",
        sender: "Recent 2",
        sentAtMs: 1_699_999_997_000,
        messagePosition: 6,
        messageCount: 9,
        messageId: "recent-2",
      },
      {
        path: "/tmp/recent-3.png",
        contentType: "image/png",
        kind: "image",
        sender: "Recent 3",
        sentAtMs: 1_699_999_998_000,
        messagePosition: 7,
        messageCount: 9,
        messageId: "recent-3",
      },
      {
        path: "/tmp/recent-4.png",
        contentType: "image/png",
        kind: "image",
        sender: "Recent 4",
        sentAtMs: 1_699_999_999_000,
        messagePosition: 8,
        messageCount: 9,
        messageId: "recent-4",
      },
      {
        path: "C:\\Users\\Alice\\Pictures\\recent.png",
        contentType: "image/png",
        kind: "image",
        sender: "Windows",
        sentAtMs: 1_699_999_999_500,
        messagePosition: 9,
        messageCount: 9,
        messageId: "windows",
      },
    ]);
  });

  it("preserves authoritative history image kinds, order, and per-message deduplication", () => {
    const now = 1_700_000_000_000;
    const imagePath = "/tmp/openclaw-history-upload.bin";
    const stickerPath = "/tmp/openclaw-history-sticker";
    const ctx = buildTestCtx({
      Timestamp: now,
      InboundHistory: [
        {
          sender: "@alice",
          body: "<media:image>",
          timestamp: now - 2_000,
          messageId: "image-message",
          media: [
            { path: imagePath, contentType: "application/octet-stream", kind: "image" },
            { path: imagePath, contentType: "application/octet-stream", kind: "image" },
          ],
        },
        {
          sender: "@bob",
          body: "<media:sticker>",
          timestamp: now - 1_000,
          messageId: "sticker-message",
          media: [{ path: stickerPath, kind: "sticker" }],
        },
        {
          sender: "@eve",
          body: "<media:document>",
          timestamp: now,
          messageId: "document-message",
          media: [{ path: "/tmp/openclaw-history-document.bin", kind: "document" }],
        },
      ],
    });

    expect(resolveRecentInboundHistoryImages({ ctx, isImageAttachment })).toEqual([
      {
        path: imagePath,
        contentType: "application/octet-stream",
        kind: "image",
        sender: "@alice",
        sentAtMs: now - 2_000,
        messagePosition: 1,
        messageCount: 3,
        messageId: "image-message",
      },
      {
        path: stickerPath,
        kind: "sticker",
        sender: "@bob",
        sentAtMs: now - 1_000,
        messagePosition: 2,
        messageCount: 3,
        messageId: "sticker-message",
      },
    ]);
  });

  it.each([undefined, "application/pdf", "image/png"] as const)(
    "never reuses a historical document with an image-looking path and MIME %s",
    (contentType) => {
      const now = 1_700_000_000_000;
      const ctx = buildTestCtx({
        Timestamp: now,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:document>",
            timestamp: now,
            media: [{ path: "/tmp/openclaw-history-document.png", contentType, kind: "document" }],
          },
        ],
      });

      expect(resolveRecentInboundHistoryImages({ ctx, isImageAttachment })).toEqual([]);
    },
  );

  it("never reuses filename-only SVG history as a raster image", () => {
    const now = 1_700_000_000_000;
    const ctx = buildTestCtx({
      Timestamp: now,
      InboundHistory: [
        {
          sender: "@alice",
          body: "<media:document>",
          timestamp: now,
          media: [{ path: "/tmp/openclaw-history-diagram.svg" }],
        },
      ],
    });

    expect(resolveRecentInboundHistoryImages({ ctx, isImageAttachment })).toEqual([]);
  });

  it.each(["application/pdf", "application/zip", "text/plain"] as const)(
    "never reuses unknown-kind image-looking history with concrete MIME %s",
    (contentType) => {
      const now = 1_700_000_000_000;
      const ctx = buildTestCtx({
        Timestamp: now,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:document>",
            timestamp: now,
            media: [{ path: "/tmp/openclaw-history-report.png", contentType, kind: "unknown" }],
          },
        ],
      });

      expect(resolveRecentInboundHistoryImages({ ctx, isImageAttachment })).toEqual([]);
    },
  );

  it("adds recent history image context without exposing paths", () => {
    const text = appendRecentHistoryImageContext({
      promptText: "what is this?",
      images: [
        {
          path: "/tmp/secret.png",
          contentType: "image/png",
          sender: "@alice",
          sentAtMs: 1_700_000_000_000,
          messagePosition: 2,
          messageCount: 5,
          messageId: "msg-1",
        },
      ],
    });

    expect(text).toContain("what is this?");
    expect(text).toContain("Recent image 1 from @alice, message msg-1");
    expect(text).toContain("sent at 2023-11-14T22:13:20.000Z");
    expect(text).toContain("message 2 of 5 in available history");
    expect(text).not.toContain("/tmp/secret.png");
  });

  it("forwards recent history image attachments into agent runtime turns", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-history-"));
    const imagePath = path.join(tempDir, "recent.png");
    try {
      await fs.writeFile(imagePath, "recent-image");
      const result = await resolveAgentTurnAttachments({
        cfg: createAcpTestConfig(),
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          Timestamp: 1_700_000_000_000,
          InboundHistory: [
            {
              sender: "@alice",
              body: "<media:image>",
              timestamp: 1_700_000_000_000,
              messageId: "msg-1",
              media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
            },
          ],
        }),
        runtime: {
          MediaAttachmentCache: class {
            constructor(private readonly attachments: Array<{ path?: string; index: number }>) {}
            async getBuffer({ attachmentIndex }: { attachmentIndex: number }) {
              const attachment = this.attachments.find((item) => item.index === attachmentIndex);
              return {
                buffer: Buffer.from(attachment?.path ?? ""),
                mime: "image/png",
                fileName: "recent.png",
                size: attachment?.path?.length ?? 0,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          isImageAttachment,
          normalizeAttachments: () => [],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(result.attachments).toEqual([
        {
          mediaType: "image/png",
          data: Buffer.from(imagePath).toString("base64"),
        },
      ]);
      expect(result.recentHistoryImages).toEqual([
        {
          path: imagePath,
          contentType: "image/png",
          kind: "image",
          sender: "@alice",
          sentAtMs: 1_700_000_000_000,
          messagePosition: 1,
          messageCount: 1,
          messageId: "msg-1",
        },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps text-only turns off the agent media runtime", async () => {
    const normalizeAttachments = vi.fn(() => {
      throw new Error("media runtime should not be touched");
    });

    const result = await resolveAgentTurnAttachments({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        BodyForAgent: "hello",
      }),
      runtime: {
        MediaAttachmentCache: class {
          readonly __mock = true;
        } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
        isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
          false,
        isImageAttachment,
        normalizeAttachments,
        resolveMediaAttachmentLocalRoots: () => [],
      },
    });

    expect(result).toEqual({ attachments: [], recentHistoryImages: [] });
    expect(normalizeAttachments).not.toHaveBeenCalled();
  });

  it("does not inject recent history images when the current turn already has an image", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-current-"));
    const currentPath = path.join(tempDir, "current.png");
    const historyPath = path.join(tempDir, "history.png");
    try {
      await fs.writeFile(currentPath, "current-image");
      await fs.writeFile(historyPath, "history-image");
      const result = await resolveAgentTurnAttachments({
        cfg: createAcpTestConfig(),
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          media: [{ path: currentPath, contentType: "image/png" }],
          Timestamp: 1_700_000_000_000,
          InboundHistory: [
            {
              sender: "@alice",
              body: "<media:image>",
              timestamp: 1_700_000_000_000,
              media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
            },
          ],
        }),
        runtime: {
          MediaAttachmentCache: class {
            async getBuffer() {
              return {
                buffer: Buffer.from("current-image"),
                mime: "image/png",
                fileName: "current.png",
                size: "current-image".length,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          isImageAttachment,
          normalizeAttachments: (ctx) => [
            { path: ctx.media?.[0]?.path, mime: ctx.media?.[0]?.contentType, index: 0 },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.recentHistoryImages).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps history attachment indexes distinct from sparse current media indexes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-sparse-history-"));
    const currentPath = path.join(tempDir, "current.png");
    const historyPath = path.join(tempDir, "history.png");
    const seenAttachmentIndexes: number[] = [];
    try {
      await fs.writeFile(currentPath, "current-image");
      await fs.writeFile(historyPath, "history-image");
      const result = await resolveAgentTurnAttachments({
        cfg: createAcpTestConfig(),
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          media: [{ path: currentPath, contentType: "image/png" }],
          Timestamp: 1_700_000_000_000,
          InboundHistory: [
            {
              sender: "@alice",
              body: "<media:image>",
              timestamp: 1_700_000_000_000,
              messageId: "msg-history",
              media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
            },
          ],
        }),
        runtime: {
          MediaAttachmentCache: class {
            constructor(private readonly attachments: Array<{ path?: string; index: number }>) {}
            async getBuffer({ attachmentIndex }: { attachmentIndex: number }) {
              seenAttachmentIndexes.push(attachmentIndex);
              const attachment = this.attachments.find((item) => item.index === attachmentIndex);
              return {
                buffer: Buffer.from(attachment?.path ?? ""),
                mime: "image/png",
                fileName: "current.png",
                size: attachment?.path?.length ?? 0,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          isImageAttachment,
          normalizeAttachments: (ctx) => [
            { path: ctx.media?.[0]?.path, mime: ctx.media?.[0]?.contentType, index: 1 },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(result.attachments).toEqual([
        {
          mediaType: "image/png",
          data: Buffer.from(currentPath).toString("base64"),
        },
      ]);
      expect(result.recentHistoryImages).toEqual([]);
      expect(seenAttachmentIndexes).toEqual([1]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not fall back to recent history images when the current turn has non-image media", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-current-pdf-"));
    const documentPath = path.join(tempDir, "current.pdf");
    const historyPath = path.join(tempDir, "history.png");
    const getBuffer = vi.fn();
    try {
      await fs.writeFile(documentPath, "current-pdf");
      await fs.writeFile(historyPath, "history-image");
      const result = await resolveAgentTurnAttachments({
        cfg: createAcpTestConfig(),
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          media: [{ path: documentPath, contentType: "application/pdf" }],
          Timestamp: 1_700_000_000_000,
          InboundHistory: [
            {
              sender: "@alice",
              body: "<media:image>",
              timestamp: 1_700_000_000_000,
              messageId: "msg-history",
              media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
            },
          ],
        }),
        runtime: {
          MediaAttachmentCache: class {
            async getBuffer(params: { attachmentIndex: number }) {
              return getBuffer(params);
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          isImageAttachment,
          normalizeAttachments: (ctx) => [
            { path: ctx.media?.[0]?.path, mime: ctx.media?.[0]?.contentType, index: 0 },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(result).toEqual({ attachments: [], recentHistoryImages: [] });
      expect(getBuffer).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to recent history images when current image attachments are unusable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-history-fallback-"));
    const historyPath = path.join(tempDir, "history.png");
    try {
      await fs.writeFile(historyPath, "history-image");
      const result = await resolveAgentTurnAttachments({
        cfg: createAcpTestConfig(),
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          media: [{ url: "https://example.com/current.png", contentType: "image/png" }],
          Timestamp: 1_700_000_000_000,
          InboundHistory: [
            {
              sender: "@alice",
              body: "<media:image>",
              timestamp: 1_700_000_000_000,
              messageId: "msg-history",
              media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
            },
          ],
        }),
        runtime: {
          MediaAttachmentCache: class {
            constructor(private readonly attachments: Array<{ path?: string; index: number }>) {}
            async getBuffer({ attachmentIndex }: { attachmentIndex: number }) {
              const attachment = this.attachments.find((item) => item.index === attachmentIndex);
              return {
                buffer: Buffer.from(attachment?.path ?? ""),
                mime: "image/png",
                fileName: "history.png",
                size: attachment?.path?.length ?? 0,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          isImageAttachment,
          normalizeAttachments: (ctx) => [
            { url: ctx.media?.[0]?.url, mime: ctx.media?.[0]?.contentType, index: 0 },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(result.attachments).toEqual([
        {
          mediaType: "image/png",
          data: Buffer.from(historyPath).toString("base64"),
        },
      ]);
      expect(result.recentHistoryImages).toEqual([
        {
          path: historyPath,
          contentType: "image/png",
          kind: "image",
          sender: "@alice",
          sentAtMs: 1_700_000_000_000,
          messagePosition: 1,
          messageCount: 1,
          messageId: "msg-history",
        },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards chat.send inline image attachments into agent runtime turns", async () => {
    setReadyAcpResolution();
    const image = {
      mimeType: "image/png",
      data: Buffer.from("image-bytes").toString("base64"),
    };

    expect(resolveInlineAgentImageAttachments([image])).toEqual([
      {
        mediaType: "image/png",
        data: image.data,
      },
    ]);

    await runDispatch({
      bodyForAgent: "describe image",
      images: [image],
    });

    expect(runTurnCall().text).toBe("describe image");
    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: image.data,
      },
    ]);
  });

  it.each([
    {
      name: "generic Telegram image bytes under a .bin path",
      imagePath: "/tmp/openclaw-acp-image-upload.bin",
      contentType: "application/octet-stream",
      kind: "image" as const,
      imageBytes: ACP_PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
    {
      name: "an extensionless image without transport MIME",
      imagePath: "/tmp/openclaw-acp-image-upload",
      contentType: undefined,
      kind: "image" as const,
      imageBytes: ACP_JPEG_IMAGE_BYTES,
      expectedMime: "image/jpeg",
    },
    {
      name: "a sticker with generic transport MIME",
      imagePath: "/tmp/openclaw-acp-sticker.bin",
      contentType: "application/octet-stream",
      kind: "sticker" as const,
      imageBytes: ACP_PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
  ])("forwards $name into the ACP runtime using the verified byte MIME", async (testCase) => {
    setReadyAcpResolution();
    acpAttachmentBuffers.set(testCase.imagePath, testCase.imageBytes);

    await runDispatch({
      bodyForAgent: "describe image",
      ctxOverrides: {
        media: [
          {
            path: testCase.imagePath,
            contentType: testCase.contentType,
            kind: testCase.kind,
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: testCase.expectedMime,
        data: testCase.imageBytes.toString("base64"),
      },
    ]);
  });

  it.each([
    { name: "valid PNG bytes without MIME", contentType: undefined, bytes: ACP_PNG_IMAGE_BYTES },
    {
      name: "valid PNG bytes with PDF MIME",
      contentType: "application/pdf",
      bytes: ACP_PNG_IMAGE_BYTES,
    },
    {
      name: "valid PNG bytes with contradictory image MIME",
      contentType: "image/png",
      bytes: ACP_PNG_IMAGE_BYTES,
    },
    {
      name: "PDF bytes with an image-looking filename",
      contentType: undefined,
      bytes: ACP_PDF_BYTES,
    },
    {
      name: "ZIP bytes with an image-looking filename",
      contentType: "application/pdf",
      bytes: ACP_ZIP_BYTES,
    },
  ])("never forwards $name or substitutes unrelated history for a document", async (testCase) => {
    setReadyAcpResolution();
    const documentPath = "/tmp/openclaw-acp-authoritative-document.png";
    const historyPath = "/tmp/openclaw-acp-unrelated-history.png";
    acpAttachmentBuffers.set(documentPath, testCase.bytes);
    acpAttachmentBuffers.set(historyPath, ACP_PNG_IMAGE_BYTES);

    await runDispatch({
      bodyForAgent: "summarize this document",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        media: [{ path: documentPath, contentType: testCase.contentType, kind: "document" }],
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toBeUndefined();
    expect(runTurnCall().text).not.toContain("Recent image");
  });

  it.each(["application/pdf", "application/zip", "text/plain"] as const)(
    "never forwards unknown-kind PNG bytes with MIME %s or substitutes history",
    async (contentType) => {
      setReadyAcpResolution();
      const documentPath = "/tmp/openclaw-acp-unknown-document.png";
      const historyPath = "/tmp/openclaw-acp-unrelated-history.png";
      acpAttachmentBuffers.set(documentPath, ACP_PNG_IMAGE_BYTES);
      acpAttachmentBuffers.set(historyPath, ACP_PNG_IMAGE_BYTES);

      await runDispatch({
        bodyForAgent: "summarize this upload",
        ctxOverrides: {
          Timestamp: 1_700_000_000_000,
          media: [{ path: documentPath, contentType, kind: "unknown" }],
          InboundHistory: [
            {
              sender: "@alice",
              body: "<media:image>",
              timestamp: 1_700_000_000_000,
              media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
            },
          ],
        },
      });

      expect(runTurnCall().attachments).toBeUndefined();
      expect(runTurnCall().text).not.toContain("Recent image");
    },
  );

  it("never forwards filename-only SVG history into an ACP runtime turn", async () => {
    setReadyAcpResolution();
    const svgPath = "/tmp/openclaw-acp-history-diagram.svg";
    acpAttachmentBuffers.set(svgPath, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));

    await runDispatch({
      bodyForAgent: "describe the recent attachment",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:document>",
            timestamp: 1_700_000_000_000,
            media: [{ path: svgPath }],
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toBeUndefined();
    expect(runTurnCall().text).not.toContain("Recent image");
  });

  it.each([
    { name: "PDF", bytes: ACP_PDF_BYTES },
    { name: "ZIP", bytes: ACP_ZIP_BYTES },
  ])(
    "never forwards $name bytes with a spoofed image kind, MIME, and filename",
    async (testCase) => {
      setReadyAcpResolution();
      const imagePath = `/tmp/openclaw-acp-spoofed-${testCase.name.toLowerCase()}.png`;
      acpAttachmentBuffers.set(imagePath, testCase.bytes);

      await runDispatch({
        bodyForAgent: "describe attachment",
        ctxOverrides: {
          media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
        },
      });

      expect(runTurnCall().attachments).toBeUndefined();
    },
  );

  it("falls back to history when an authoritative current image contains document bytes", async () => {
    setReadyAcpResolution();
    const currentPath = "/tmp/openclaw-acp-current-spoofed.bin";
    const historyPath = "/tmp/openclaw-acp-history-valid.bin";
    acpAttachmentBuffers.set(currentPath, ACP_PDF_BYTES);
    acpAttachmentBuffers.set(historyPath, ACP_PNG_IMAGE_BYTES);

    await runDispatch({
      bodyForAgent: "describe the recent image",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        media: [{ path: currentPath, contentType: "image/png", kind: "image" }],
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: ACP_PNG_IMAGE_BYTES.toString("base64"),
      },
    ]);
  });

  it("does not substitute history for an authoritative current document", async () => {
    setReadyAcpResolution();
    const documentPath = "/tmp/openclaw-acp-current-document.bin";
    const historyPath = "/tmp/openclaw-acp-history-image.png";
    acpAttachmentBuffers.set(documentPath, ACP_PDF_BYTES);
    acpAttachmentBuffers.set(historyPath, ACP_PNG_IMAGE_BYTES);

    await runDispatch({
      bodyForAgent: "describe this document",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        media: [{ path: documentPath, contentType: "application/pdf", kind: "document" }],
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toBeUndefined();
  });

  it.each([
    {
      name: "a historical Telegram .bin image with generic MIME",
      imagePath: "/tmp/openclaw-acp-history-upload.bin",
      contentType: "application/octet-stream",
      kind: "image" as const,
      imageBytes: ACP_PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
    {
      name: "an extensionless historical image without MIME",
      imagePath: "/tmp/openclaw-acp-history-upload",
      contentType: undefined,
      kind: "image" as const,
      imageBytes: ACP_JPEG_IMAGE_BYTES,
      expectedMime: "image/jpeg",
    },
    {
      name: "a historical sticker with generic MIME",
      imagePath: "/tmp/openclaw-acp-history-sticker.bin",
      contentType: "application/octet-stream",
      kind: "sticker" as const,
      imageBytes: ACP_PNG_IMAGE_BYTES,
      expectedMime: "image/png",
    },
  ])("forwards $name into the ACP runtime using the verified byte MIME", async (testCase) => {
    setReadyAcpResolution();
    acpAttachmentBuffers.set(testCase.imagePath, testCase.imageBytes);

    await runDispatch({
      bodyForAgent: "describe the recent attachment",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            messageId: "history-message",
            media: [
              {
                path: testCase.imagePath,
                contentType: testCase.contentType,
                kind: testCase.kind,
              },
            ],
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: testCase.expectedMime,
        data: testCase.imageBytes.toString("base64"),
      },
    ]);
  });

  it.each([
    { name: "PDF", bytes: ACP_PDF_BYTES },
    { name: "ZIP", bytes: ACP_ZIP_BYTES },
  ])("does not forward historical $name bytes disguised as image media", async (testCase) => {
    setReadyAcpResolution();
    const imagePath = `/tmp/openclaw-acp-history-spoofed-${testCase.name.toLowerCase()}.png`;
    acpAttachmentBuffers.set(imagePath, testCase.bytes);

    await runDispatch({
      bodyForAgent: "describe the recent attachment",
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
          },
        ],
      },
    });

    expect(runTurnCall().attachments).toBeUndefined();
  });

  it("annotates recent history images with sent time and available history position", async () => {
    setReadyAcpResolution();
    const historyPath = "/tmp/openclaw-history-metadata.png";
    const historyImage = Buffer.from("history-image");
    acpAttachmentBuffers.set(historyPath, historyImage);

    await runDispatch({
      bodyForAgent: "describe current state",
      ctxOverrides: {
        Timestamp: 1_700_000_060_000,
        InboundHistory: [
          {
            sender: "@alice",
            body: "bug report",
            timestamp: 1_699_999_980_000,
            messageId: "msg-before",
          },
          {
            sender: "@bob",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            messageId: "msg-history",
            media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
          },
          {
            sender: "@alice",
            body: "fixed after refresh",
            timestamp: 1_700_000_060_000,
            messageId: "msg-after",
          },
        ],
      },
    });

    const text = String(runTurnCall().text);
    expect(text).toContain("describe current state");
    expect(text).toContain("Recent image 1 from @bob, message msg-history");
    expect(text).toContain("sent at 2023-11-14T22:13:20.000Z");
    expect(text).toContain("message 2 of 3 in available history");
    expect(text).not.toContain(historyPath);
    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: historyImage.toString("base64"),
      },
    ]);
  });

  it("forwards media-understanding PDF page images alongside current image attachments", async () => {
    setReadyAcpResolution();
    const currentPath = "/tmp/openclaw-current-image.png";
    const currentImage = Buffer.from("current-image");
    const pdfPage = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.from("pdf-page").toString("base64"),
      attachmentIndex: 1,
    };
    acpAttachmentBuffers.set(currentPath, currentImage);
    mediaUnderstandingMocks.applyMediaUnderstanding.mockResolvedValueOnce({
      outputs: [],
      decisions: [],
      extractedFileImages: [pdfPage],
      appliedImage: false,
      appliedAudio: false,
      appliedVideo: false,
      appliedFile: true,
    });

    await runDispatch({
      bodyForAgent: "describe current image and scanned PDF",
      ctxOverrides: {
        media: [{ path: currentPath, contentType: "image/png" }],
      },
    });

    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: currentImage.toString("base64"),
      },
      {
        mediaType: "image/png",
        data: pdfPage.data,
      },
    ]);
  });

  it("preserves chat.send inline image attachments over recent history images", async () => {
    setReadyAcpResolution();
    const image = {
      mimeType: "image/png",
      data: Buffer.from("inline-image").toString("base64"),
    };
    const historyPath = "/tmp/openclaw-history-inline.png";
    acpAttachmentBuffers.set(historyPath, Buffer.from("history-image"));

    await runDispatch({
      bodyForAgent: "describe image",
      images: [image],
      ctxOverrides: {
        Timestamp: 1_700_000_000_000,
        InboundHistory: [
          {
            sender: "@alice",
            body: "<media:image>",
            timestamp: 1_700_000_000_000,
            messageId: "msg-history",
            media: [{ path: historyPath, contentType: "image/png", kind: "image" }],
          },
        ],
      },
    });

    expect(runTurnCall().text).toBe("describe image");
    expect(runTurnCall().attachments).toEqual([
      {
        mediaType: "image/png",
        data: image.data,
      },
    ]);
  });

  it("skips agent runtime attachments outside allowed inbound roots", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "outside-root.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      managerMocks.runTurn.mockResolvedValue(undefined);

      await runDispatch({
        bodyForAgent: "   ",
        ctxOverrides: {
          MediaPath: imagePath,
          MediaType: "image/png",
        },
      });

      expect(managerMocks.runTurn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips file URL agent runtime attachments outside allowed inbound roots", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "outside-root.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      managerMocks.runTurn.mockResolvedValue(undefined);

      await runDispatch({
        bodyForAgent: "   ",
        ctxOverrides: {
          MediaPath: `file://${imagePath}`,
          MediaType: "image/png",
        },
      });

      expect(managerMocks.runTurn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips relative ACP attachment paths that resolve outside allowed inbound roots", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "outside-root.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      managerMocks.runTurn.mockResolvedValue(undefined);

      await runDispatch({
        bodyForAgent: "   ",
        ctxOverrides: {
          MediaPath: path.relative(process.cwd(), imagePath),
          MediaType: "image/png",
        },
      });

      expect(managerMocks.runTurn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not fall back to remote URLs when ACP local attachment paths are blocked", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "outside-root.png");
    const fetchSpy = vi.fn(
      async () =>
        new Response(Buffer.from("remote-image"), {
          headers: {
            "content-type": "image/png",
          },
        }),
    );
    globalThis.fetch = withFetchPreconnect(fetchSpy as typeof fetch);
    try {
      await fs.writeFile(imagePath, "image-bytes");
      managerMocks.runTurn.mockResolvedValue(undefined);

      await runDispatch({
        bodyForAgent: "   ",
        ctxOverrides: {
          MediaPath: imagePath,
          MediaUrl: "https://example.com/image.png",
          MediaType: "image/png",
        },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(managerMocks.runTurn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips ACP turns for non-image attachments when there is no text prompt", async () => {
    setReadyAcpResolution();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const docPath = path.join(tempDir, "inbound.pdf");
    const { dispatcher } = createDispatcher();
    const onReplyStart = vi.fn();
    try {
      await fs.writeFile(docPath, "pdf-bytes");

      await runDispatch({
        bodyForAgent: "   ",
        dispatcher,
        onReplyStart,
        ctxOverrides: {
          MediaPath: docPath,
          MediaType: "application/pdf",
        },
      });

      expect(managerMocks.runTurn).not.toHaveBeenCalled();
      expect(onReplyStart).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces ACP policy errors as final error replies", async () => {
    setReadyAcpResolution();
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(
      new AcpRuntimeError("ACP_DISPATCH_DISABLED", "ACP dispatch is disabled by policy."),
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain(
      "ACP dispatch is disabled by policy.",
    );
    expect(bindingServiceMocks.unbind).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleStart).toHaveBeenCalledOnce();
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
    expect(auditMocks.emitAcpLifecycleEnd).not.toHaveBeenCalled();
  });

  it("fails closed when ACP dispatch cannot enforce restrictive runtime toolsAllow", async () => {
    setReadyAcpResolution();
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      toolsAllow: ["message"],
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain(
      "cannot enforce its tool policy",
    );
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
  });

  it("fails visibly when a bound ACP runtime receives restrictive conversation policy", async () => {
    setReadyAcpResolution();
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      ctxOverrides: { ConversationToolPolicy: { deny: ["exec"] } },
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply)).toMatchObject({
      isError: true,
      text: expect.stringContaining("use an embedded runtime"),
    });
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
  });

  it("audits ACP agent-policy rejections as blocked attempts", async () => {
    setReadyAcpResolution();
    policyMocks.resolveAcpAgentPolicyError.mockReturnValue(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent is not allowed by policy."),
    );

    await runDispatch({ bodyForAgent: "test" });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(auditMocks.emitAcpLifecycleStart).toHaveBeenCalledOnce();
    expect(auditMocks.emitAcpLifecycleError).toHaveBeenCalledWith(
      expect.objectContaining({ terminalOutcome: "blocked" }),
    );
    expect(auditMocks.emitAcpLifecycleEnd).not.toHaveBeenCalled();
  });

  it("allows wildcard runtime toolsAllow through ACP dispatch", async () => {
    setReadyAcpResolution();
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      toolsAllow: ["*"],
    });

    expect(managerMocks.runTurn).toHaveBeenCalledOnce();
    expect(runTurnCall().text).toBe("test");
  });

  it("does not unbind stale bindings when ACP dispatch is disabled by policy", async () => {
    managerMocks.resolveSession.mockReturnValue({
      kind: "stale",
      sessionKey,
      error: new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP metadata is missing."),
    });
    policyMocks.resolveAcpDispatchPolicyError.mockReturnValue(
      new AcpRuntimeError("ACP_DISPATCH_DISABLED", "ACP dispatch is disabled by policy."),
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(bindingServiceMocks.unbind).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain(
      "ACP dispatch is disabled by policy.",
    );
  });

  it("unbinds stale bound conversations before surfacing stale ACP resolution errors", async () => {
    const aliasSessionKey = "main";
    const canonicalSessionKey = "agent:main:main";
    managerMocks.resolveSession.mockReturnValue({
      kind: "stale",
      sessionKey: canonicalSessionKey,
      error: new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP metadata is missing."),
    });
    bindingServiceMocks.unbind.mockResolvedValueOnce([
      {
        bindingId: "discord:default:thread-1",
        targetSessionKey: canonicalSessionKey,
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
        status: "active",
        boundAt: 0,
      },
    ]);
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      sessionKeyOverride: aliasSessionKey,
    });

    expect(managerMocks.runTurn).not.toHaveBeenCalled();
    expect(bindingServiceMocks.unbind).toHaveBeenCalledTimes(1);
    expect(bindingServiceMocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: canonicalSessionKey,
      reason: "acp-session-init-failed",
    });
    expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain("ACP metadata is missing.");
  });

  it("does not unbind valid bindings on generic ACP runTurn init failure", async () => {
    setReadyAcpResolution();
    // Match the post-reset module instance so dispatch-acp preserves the ACP error code.
    managerMocks.runTurn.mockRejectedValueOnce(
      new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Could not initialize ACP session runtime."),
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
    });

    expect(bindingServiceMocks.unbind).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain(
      "Could not initialize ACP session runtime.",
    );
  });

  it("unbinds stale bindings on ACP runTurn missing-metadata failures", async () => {
    const aliasSessionKey = "main";
    const canonicalSessionKey = "agent:main:main";
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: canonicalSessionKey,
      meta: createAcpSessionMeta(),
    });
    managerMocks.runTurn.mockRejectedValueOnce(
      new AcpRuntimeError(
        "ACP_SESSION_INIT_FAILED",
        `ACP metadata is missing for ${canonicalSessionKey}. Recreate this ACP session with /acp spawn and rebind the thread.`,
      ),
    );
    bindingServiceMocks.unbind.mockResolvedValueOnce([
      {
        bindingId: "discord:default:thread-1",
        targetSessionKey: canonicalSessionKey,
        targetKind: "session",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "thread-1",
        },
        status: "active",
        boundAt: 0,
      },
    ]);
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      sessionKeyOverride: aliasSessionKey,
    });

    expect(bindingServiceMocks.unbind).toHaveBeenCalledTimes(1);
    expect(bindingServiceMocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: canonicalSessionKey,
      reason: "acp-session-init-failed",
    });
    expect(dispatcherCall(dispatcher.sendFinalReply).isError).toBe(true);
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toContain("ACP metadata is missing");
  });

  it("uses canonical session keys for bound-session identity notices", async () => {
    const aliasSessionKey = "main";
    const canonicalSessionKey = "agent:main:main";
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: canonicalSessionKey,
      meta: createAcpSessionMeta({
        identity: {
          state: "pending",
          source: "ensure",
          lastUpdatedAt: Date.now(),
          acpxRecordId: "rec-main",
        },
      }),
    });
    bindingServiceMocks.listBySession.mockImplementation((targetSessionKey: string) =>
      targetSessionKey === canonicalSessionKey
        ? [
            {
              bindingId: "discord:default:thread-1",
              targetSessionKey: canonicalSessionKey,
              targetKind: "session",
              conversation: {
                channel: "discord",
                accountId: "default",
                conversationId: "thread-1",
              },
              status: "active",
              boundAt: 0,
            },
          ]
        : [],
    );
    sessionMetaMocks.readAcpSessionEntry.mockImplementation(
      (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
        params.sessionKey === canonicalSessionKey
          ? {
              cfg: params.cfg ?? createAcpTestConfig(),
              storePath: "/tmp/openclaw-session-store.json",
              sessionKey: canonicalSessionKey,
              storeSessionKey: canonicalSessionKey,
              acp: createAcpSessionMeta({
                identity: {
                  state: "resolved",
                  source: "status",
                  lastUpdatedAt: Date.now(),
                  acpxSessionId: "acpx-main",
                },
              }),
            }
          : null,
    );
    managerMocks.runTurn.mockResolvedValue(undefined);
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      sessionKeyOverride: aliasSessionKey,
    });

    expect(bindingServiceMocks.listBySession).toHaveBeenCalledWith(canonicalSessionKey);
    expect(dispatcherCall(dispatcher.sendFinalReply, 0).text).toContain("Session ids resolved.");
    expect(dispatcherCall(dispatcher.sendFinalReply, 0).text).toContain(
      "acpx session id: acpx-main",
    );
  });

  it("honors the configured default account when checking bound-session identity notices", async () => {
    const canonicalSessionKey = "agent:main:main";
    managerMocks.resolveSession.mockReturnValue({
      kind: "ready",
      sessionKey: canonicalSessionKey,
      meta: createAcpSessionMeta({
        identity: {
          state: "pending",
          source: "ensure",
          lastUpdatedAt: Date.now(),
          acpxRecordId: "rec-work",
        },
      }),
    });
    bindingServiceMocks.listBySession.mockImplementation((targetSessionKey: string) =>
      targetSessionKey === canonicalSessionKey
        ? [
            {
              bindingId: "discord:work:thread-1",
              targetSessionKey: canonicalSessionKey,
              targetKind: "session",
              conversation: {
                channel: "discord",
                accountId: "work",
                conversationId: "thread-1",
              },
              status: "active",
              boundAt: 0,
            },
          ]
        : [],
    );
    sessionMetaMocks.readAcpSessionEntry.mockImplementation(
      (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
        params.sessionKey === canonicalSessionKey
          ? {
              cfg: params.cfg ?? createAcpTestConfig(),
              storePath: "/tmp/openclaw-session-store.json",
              sessionKey: canonicalSessionKey,
              storeSessionKey: canonicalSessionKey,
              acp: createAcpSessionMeta({
                identity: {
                  state: "resolved",
                  source: "status",
                  lastUpdatedAt: Date.now(),
                  acpxSessionId: "acpx-work",
                },
              }),
            }
          : null,
    );
    managerMocks.runTurn.mockResolvedValue(undefined);
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "test",
      dispatcher,
      cfg: createAcpTestConfig({
        channels: {
          discord: {
            defaultAccount: "work",
          },
        },
      }),
      ctxOverrides: {
        Provider: "discord",
        Surface: "discord",
      },
      sessionKeyOverride: canonicalSessionKey,
    });

    expect(bindingServiceMocks.listBySession).toHaveBeenCalledWith(canonicalSessionKey);
    expect(dispatcherCall(dispatcher.sendFinalReply, 0).text).toContain("Session ids resolved.");
    expect(dispatcherCall(dispatcher.sendFinalReply, 0).text).toContain(
      "acpx session id: acpx-work",
    );
  });

  it("does not add a fallback when routed ACP text was already delivered as final", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies({ text: "CODEX_OK" }, {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>);
    const { result } = await runRoutedAcpTextTurn("CODEX_OK");

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
  });

  it("routes default ACP text as one final reply to Discord", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies(
      { text: "Received your test message." },
      {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>,
    );
    mockRoutedTextTurn("Received your test message.");

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "run acp",
      dispatcher,
      shouldRouteToOriginating: true,
      originatingChannel: "discord",
      originatingTo: "channel:1478836151241412759",
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(routeCall().channel).toBe("discord");
    expect(routeCall().to).toBe("channel:1478836151241412759");
    expect(routePayload().text).toBe("Received your test message.");
  });

  it("routes default ACP text as one final reply to Slack", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies(
      { text: "Shared update." },
      {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>,
    );
    mockRoutedTextTurn("Shared update.");

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "run acp",
      dispatcher,
      shouldRouteToOriginating: true,
      originatingChannel: "slack",
      originatingTo: "channel:C123",
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expect(routeCall().channel).toBe("slack");
    expect(routeCall().to).toBe("channel:C123");
    expect(routePayload().text).toBe("Shared update.");
  });

  it("delivers default Telegram ACP text directly as a final reply", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies({ text: "CODEX_OK" }, {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>);
    mockVisibleTextTurn("CODEX_OK");

    const { dispatcher, counts } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: {
        Provider: "telegram",
        Surface: "telegram",
      },
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(0);
    expect(counts.block).toBe(0);
    expect(counts.final).toBe(0);
    expect(result?.queuedFinal).toBe(true);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("CODEX_OK");
  });

  it("delivers default Discord ACP text directly as a final reply", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies(
      { text: "Received." },
      {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>,
    );
    mockVisibleTextTurn("Received.");

    const { dispatcher, counts } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: {
        Provider: "discord",
        Surface: "discord",
      },
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(0);
    expect(counts.block).toBe(0);
    expect(counts.final).toBe(0);
    expect(result?.queuedFinal).toBe(true);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("Received.");
  });

  it("delivers default Slack ACP text directly as a final reply", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies(
      { text: "Slack says hi." },
      {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>,
    );
    mockVisibleTextTurn("Slack says hi.");

    const { dispatcher, counts } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: {
        Provider: "slack",
        Surface: "slack",
      },
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(0);
    expect(counts.block).toBe(0);
    expect(counts.final).toBe(0);
    expect(result?.queuedFinal).toBe(true);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("Slack says hi.");
  });

  it("treats Telegram ACP final delivery as a successful final response", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies({ text: "CODEX_OK" }, {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>);
    mockVisibleTextTurn("CODEX_OK");

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: {
        Provider: "telegram",
        Surface: "telegram",
      },
    });

    expect(result?.queuedFinal).toBe(true);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("CODEX_OK");
  });

  it("delivers default ACP text as final for channels without a visibility override", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies({ text: "CODEX_OK" }, {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>);
    mockVisibleTextTurn("CODEX_OK");

    const { dispatcher, counts } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: {
        Provider: "whatsapp",
        Surface: "whatsapp",
      },
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(0);
    expect(counts.block).toBe(0);
    expect(counts.final).toBe(0);
    expect(result?.queuedFinal).toBe(true);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("CODEX_OK");
  });

  it("marks accumulated ACP block TTS finals as trusted local media for WebChat", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies({
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
    } as MockTtsReply);
    mockVisibleTextTurn("WebChat ACP block reply.");
    const cfg = createAcpTestConfig({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
        },
      },
    });

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "reply",
      cfg,
      dispatcher,
      ctxOverrides: {
        Provider: "webchat",
        Surface: "webchat",
      },
    });

    const finalPayload = dispatcherCall(dispatcher.sendFinalReply);
    expect(finalPayload.mediaUrl).toBe("/tmp/openclaw-media/acp-tts.ogg");
    expect(finalPayload.audioAsVoice).toBe(true);
    expect(finalPayload.spokenText).toBe("WebChat ACP block reply.");
    expect(finalPayload.trustedLocalMedia).toBe(true);
    expect(result?.queuedFinal).toBe(true);
  });

  it("delivers Telegram ACP final-mode TTS as one captioned voice reply", async () => {
    setReadyAcpResolution();
    ttsCapabilityMocks.captionedFinalText = true;
    queueTtsReplies({
      text: "Captioned ACP reply.",
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
      spokenText: "Captioned ACP reply.",
      ttsSupplement: { spokenText: "Captioned ACP reply." },
    } as MockTtsReply);
    mockVisibleTextTurn("Captioned ACP reply.");
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: { Provider: "telegram", Surface: "telegram" },
    });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply)).toMatchObject({
      text: "Captioned ACP reply.",
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
    });
  });

  it("keeps Telegram ACP TTS-only block text out of the voice caption", async () => {
    setReadyAcpResolution();
    ttsCapabilityMocks.captionedFinalText = true;
    queueTtsReplies({
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
    } as MockTtsReply);
    mockVisibleTextTurn("[[tts:text]]Private speech.[[/tts:text]]");
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "reply",
      cfg: createAcpTestConfig({
        acp: { enabled: true, stream: { deliveryMode: "live" } },
        tts: { auto: "always" },
      }),
      dispatcher,
      ctxOverrides: { Provider: "telegram", Surface: "telegram" },
    });

    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBeUndefined();
  });

  it("keeps cross-block ACP TTS-only text out of the Telegram caption", async () => {
    setReadyAcpResolution();
    ttsCapabilityMocks.captionedFinalText = true;
    queueTtsReplies({
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
    } as MockTtsReply);
    managerMocks.runTurn.mockImplementationOnce(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          text: "Visible. [[tts:text]]Private",
          tag: "agent_message_chunk",
        });
        await onEvent({
          type: "text_delta",
          text: " speech.[[/tts:text]] Done.",
          tag: "agent_message_chunk",
        });
        await onEvent({ type: "done", status: "completed" });
      },
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "reply",
      cfg: createAcpTestConfig({
        acp: { enabled: true, stream: { deliveryMode: "live" } },
        tts: { auto: "always" },
      }),
      dispatcher,
      ctxOverrides: { Provider: "telegram", Surface: "telegram" },
    });

    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("Visible.  Done.");
  });

  it.each([
    {
      expectedText: "Private ACP speech.",
      ttsReply: { text: "Private ACP speech." },
      finalReply: {},
      streamedText: "[[tts:text]]Private ACP speech.[[/tts:text]]",
    },
    {
      expectedText: undefined,
      ttsReply: {
        text: "Private ACP speech.",
        mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
        audioAsVoice: true,
      },
      finalReply: {
        mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
        audioAsVoice: true,
      },
      streamedText: "[[tts:text]]Private ACP speech.[[/tts:text]]",
    },
    {
      expectedText: "Visible ACP answer. ",
      ttsReply: { text: "Visible ACP answer." },
      finalReply: undefined,
      streamedText: "Visible ACP answer. [[tts:text]]Private speech.[[/tts:text]]",
    },
  ])("keeps tagged ACP TTS delivery single for $streamedText", async (testCase) => {
    setReadyAcpResolution();
    queueTtsReplies(testCase.ttsReply as MockTtsReply);
    mockVisibleTextTurn(testCase.streamedText);
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "reply",
      cfg: createAcpTestConfig({
        acp: { enabled: true, stream: { deliveryMode: "live" } },
        tts: { auto: "tagged" },
      }),
      dispatcher,
      ctxOverrides: { Provider: "telegram", Surface: "telegram" },
    });

    const blockReply = vi.mocked(dispatcher.sendBlockReply).mock.calls[0]?.[0];
    const deliveredPayload = testCase.finalReply
      ? dispatcherCall(dispatcher.sendFinalReply)
      : blockReply;
    expect(deliveredPayload?.text).toBe(testCase.expectedText);
    if (testCase.finalReply) {
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
      expect(deliveredPayload).toMatchObject(testCase.finalReply);
    } else {
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    }
  });

  it("falls back to Telegram ACP text when a routed captioned voice is suppressed", async () => {
    setReadyAcpResolution();
    ttsCapabilityMocks.captionedFinalText = true;
    queueTtsReplies({
      text: "Visible ACP fallback.",
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
      audioAsVoice: true,
      spokenText: "Visible ACP fallback.",
      ttsSupplement: { spokenText: "Visible ACP fallback." },
    } as MockTtsReply);
    mockRoutedTextTurn("Visible ACP fallback.");
    routeMocks.routeReply
      .mockResolvedValueOnce({ ok: true, delivered: false, suppressed: true })
      .mockResolvedValueOnce({ ok: true, delivered: true, messageId: "fallback" });

    await runDispatch({
      bodyForAgent: "reply",
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:thread-1",
    });

    expect(routeMocks.routeReply).toHaveBeenCalledTimes(2);
    expect(routePayload(0)).toMatchObject({
      text: "Visible ACP fallback.",
      mediaUrl: "/tmp/openclaw-media/acp-tts.ogg",
    });
    expect(routePayload(1)).toEqual({ text: "Visible ACP fallback." });
  });

  it("delivers deferred Telegram ACP text when the runtime is cancelled", async () => {
    setReadyAcpResolution();
    ttsCapabilityMocks.captionedFinalText = true;
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({
          type: "text_delta",
          text: "Partial reply before cancellation.",
          tag: "agent_message_chunk",
        });
        await onEvent({ type: "done", status: "cancelled" });
      },
    );
    const { dispatcher } = createDispatcher();

    await runDispatch({
      bodyForAgent: "reply",
      dispatcher,
      ctxOverrides: { Provider: "telegram", Surface: "telegram" },
    });

    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcherCall(dispatcher.sendFinalReply)).toEqual({
      text: "Partial reply before cancellation.",
    });
  });

  it("falls back to final text when a later telegram ACP block delivery fails", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies(
      { text: "First chunk. " },
      { text: "Second chunk." },
      {} as ReturnType<typeof ttsMocks.maybeApplyTtsToPayload>,
    );
    const cfg = createAcpTestConfig({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
        },
      },
    });
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "First chunk. ", tag: "agent_message_chunk" });
        await onEvent({ type: "text_delta", text: "Second chunk.", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher } = createDispatcher();
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const result = await runDispatch({
      bodyForAgent: "reply",
      cfg,
      dispatcher,
      ctxOverrides: {
        Provider: "telegram",
        Surface: "telegram",
      },
    });

    expect(dispatcherCall(dispatcher.sendBlockReply, 0).text).toBe("First chunk. ");
    expect(dispatcherCall(dispatcher.sendBlockReply, 1).text).toBe("Second chunk.");
    expect(dispatcherCall(dispatcher.sendFinalReply).text).toBe("First chunk. \nSecond chunk.");
    expect(result?.queuedFinal).toBe(true);
  });

  it("honors the configured default account for ACP projector chunking when AccountId is omitted", async () => {
    setReadyAcpResolution();
    const cfg = createAcpTestConfig({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
        },
      },
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: {
            work: {
              textChunkLimit: 5,
            },
          },
        },
      },
    });
    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "text_delta", text: "abcdef", tag: "agent_message_chunk" });
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher } = createDispatcher();
    await runDispatch({
      bodyForAgent: "reply",
      cfg,
      dispatcher,
      ctxOverrides: {
        Provider: "discord",
        Surface: "discord",
      },
    });

    expect(dispatcherCall(dispatcher.sendBlockReply, 0).text).toBe("abcde");
    expect(dispatcherCall(dispatcher.sendBlockReply, 1).text).toBe("f");
  });

  it("does not add a second routed payload when routed final text was already visible", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    queueTtsReplies({ text: "Task completed" }, {
      mediaUrl: "https://example.com/final.mp3",
      audioAsVoice: true,
    } as MockTtsReply);
    const { result } = await runRoutedAcpTextTurn("Task completed");

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
    expectRoutedPayload(1, {
      text: "Task completed",
    });
  });

  it("skips fallback when TTS mode is all and final delivery already succeeded", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "all" });
    const { result } = await runRoutedAcpTextTurn("Response");

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(1);
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(1);
  });

  it("skips final TTS and fallback when no block text was accumulated", async () => {
    setReadyAcpResolution();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });

    managerMocks.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: unknown) => Promise<void> }) => {
        await onEvent({ type: "done" });
      },
    );

    const { dispatcher } = createDispatcher();
    const result = await runDispatch({
      bodyForAgent: "run acp",
      dispatcher,
      shouldRouteToOriginating: true,
    });

    expect(result?.counts.block).toBe(0);
    expect(result?.counts.final).toBe(0);
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
