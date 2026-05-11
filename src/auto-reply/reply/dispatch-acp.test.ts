import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { MediaUnderstandingSkipError } from "../../media-understanding/errors.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import {
  resolveAcpAttachments,
  resolveAcpInlineImageAttachments,
} from "./dispatch-acp-attachments.js";
import { tryDispatchAcpReply } from "./dispatch-acp.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpSessionMeta, createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  runTurn: vi.fn(),
  getObservabilitySnapshot: vi.fn(() => ({
    turns: { queueDepth: 0 },
    runtimeCache: { activeSessions: 0 },
  })),
}));

const policyMocks = vi.hoisted(() => ({
  resolveAcpDispatchPolicyError: vi.fn<(cfg: OpenClawConfig) => AcpRuntimeError | null>(() => null),
  resolveAcpAgentPolicyError: vi.fn<(cfg: OpenClawConfig, agent: string) => AcpRuntimeError | null>(
    () => null,
  ),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn<
    (_params: unknown) => Promise<{ ok: true; messageId: string } | { ok: false; error: string }>
  >(async () => ({ ok: true, messageId: "mock" })),
}));

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "discord" && channelId !== "slack" && channelId !== "telegram") {
      return undefined;
    }
    return {
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

const mediaUnderstandingMocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (_params: unknown) => undefined),
}));

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
  getSessionBindingService: () => ({
    listBySession: (targetSessionKey: string) =>
      bindingServiceMocks.listBySession(targetSessionKey),
    unbind: (input: unknown) => bindingServiceMocks.unbind(input),
  }),
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

vi.mock("./dispatch-acp-tts.runtime.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("../../tts/status-config.js", () => ({
  resolveStatusTtsSnapshot: () => ({
    autoMode: "always",
    provider: "auto",
    maxLength: 1500,
    summarize: true,
  }),
}));

vi.mock("./dispatch-acp-media.runtime.js", () => ({
  applyMediaUnderstanding: (params: unknown) =>
    mediaUnderstandingMocks.applyMediaUnderstanding(params),
  isMediaUnderstandingSkipError: (error: unknown): error is MediaUnderstandingSkipError =>
    error instanceof Error && error.name === "MediaUnderstandingSkipError",
  normalizeAttachments: (ctx: { MediaPath?: string; MediaType?: string }) =>
    ctx.MediaPath
      ? [
          {
            path: ctx.MediaPath,
            mime: ctx.MediaType,
            index: 0,
          },
        ]
      : [],
  resolveMediaAttachmentLocalRoots: (params: {
    cfg: { channels?: Record<string, { attachmentRoots?: string[] } | undefined> };
    ctx: { Provider?: string; Surface?: string };
  }) => {
    const channel = params.ctx.Provider ?? params.ctx.Surface ?? "";
    return params.cfg.channels?.[channel]?.attachmentRoots ?? [];
  },
  MediaAttachmentCache: class {
    async getBuffer(): Promise<never> {
      const error = new Error("outside allowed roots");
      error.name = "MediaUnderstandingSkipError";
      throw error;
    }
  },
}));

vi.mock("./dispatch-acp-session.runtime.js", () => ({
  readAcpSessionEntry: (params: { sessionKey: string; cfg?: OpenClawConfig }) =>
    sessionMetaMocks.readAcpSessionEntry(params),
}));

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  return value as Record<string, unknown>;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
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

function createDispatcher(): {
  dispatcher: ReplyDispatcher;
  counts: Record<"tool" | "block" | "final", number>;
} {
  const counts = { tool: 0, block: 0, final: 0 };
  const dispatcher: ReplyDispatcher = {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => counts),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
  return { dispatcher, counts };
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
  cfg?: OpenClawConfig;
  dispatcher?: ReplyDispatcher;
  shouldRouteToOriginating?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  onReplyStart?: () => void;
  images?: Array<{ data: string; mimeType: string }>;
  ctxOverrides?: Record<string, unknown>;
  sessionKeyOverride?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
}) {
  const targetSessionKey = params.sessionKeyOverride ?? sessionKey;
  return tryDispatchAcpReply({
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: targetSessionKey,
      BodyForAgent: params.bodyForAgent,
      ...params.ctxOverrides,
    }),
    cfg: params.cfg ?? createAcpTestConfig(),
    dispatcher: params.dispatcher ?? createDispatcher().dispatcher,
    sessionKey: targetSessionKey,
    images: params.images,
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
    bypassForCommand: false,
    ...(params.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
    recordProcessed: vi.fn(),
    markIdle: vi.fn(),
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

describe("tryDispatchAcpReply", () => {
  beforeEach(() => {
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
    routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
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
    mediaUnderstandingMocks.applyMediaUnderstanding.mockReset();
    mediaUnderstandingMocks.applyMediaUnderstanding.mockResolvedValue(undefined);
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

  it("persists ACP transcript when routed delivery fails", async () => {
    setReadyAcpResolution();
    mockRoutedTextTurn("hello");
    routeMocks.routeReply.mockResolvedValue({ ok: false, error: "missing channel adapter" });

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
    routeMocks.routeReply.mockResolvedValueOnce({ ok: true, messageId: "tool-msg-1" });

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
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2" })
      .mockResolvedValueOnce({ ok: true, messageId: "tool-msg-2-fallback" });
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
  });

  it("skips media understanding for text-only ACP turns", async () => {
    setReadyAcpResolution();
    mockVisibleTextTurn("text only");

    await runDispatch({
      bodyForAgent: "plain text prompt",
    });

    expect(mediaUnderstandingMocks.applyMediaUnderstanding).not.toHaveBeenCalled();
  });

  it("passes the ACP agent directory to media understanding", async () => {
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

      expect(
        requireRecord(
          mockArg(mediaUnderstandingMocks.applyMediaUnderstanding, 0, 0, "media understanding"),
          "media understanding",
        ).agentDir,
      ).toBe(agentDir);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards normalized image attachments into ACP turns", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-acp-"));
    const imagePath = path.join(tempDir, "inbound.png");
    try {
      await fs.writeFile(imagePath, "image-bytes");
      const attachments = await resolveAcpAttachments({
        cfg: createAcpTestConfig({
          channels: {
            imessage: {
              attachmentRoots: [tempDir],
            },
          },
        }),
        ctx: buildTestCtx({
          Provider: "imessage",
          Surface: "imessage",
          MediaPath: imagePath,
          MediaType: "image/png",
        }),
        runtime: {
          MediaAttachmentCache: class {
            async getBuffer() {
              return {
                buffer: Buffer.from("image-bytes"),
                mime: "image/png",
                fileName: "inbound.png",
                size: "image-bytes".length,
              };
            }
          } as unknown as typeof import("./dispatch-acp-media.runtime.js").MediaAttachmentCache,
          isMediaUnderstandingSkipError: (_error: unknown): _error is MediaUnderstandingSkipError =>
            false,
          normalizeAttachments: (ctx) => [
            {
              path: ctx.MediaPath,
              mime: ctx.MediaType,
              index: 0,
            },
          ],
          resolveMediaAttachmentLocalRoots: () => [tempDir],
        },
      });

      expect(attachments).toEqual([
        {
          mediaType: "image/png",
          data: Buffer.from("image-bytes").toString("base64"),
        },
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("forwards chat.send inline image attachments into ACP turns", async () => {
    setReadyAcpResolution();
    const image = {
      mimeType: "image/png",
      data: Buffer.from("image-bytes").toString("base64"),
    };

    expect(resolveAcpInlineImageAttachments([image])).toEqual([
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

  it("skips ACP attachments outside allowed inbound roots", async () => {
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

  it("skips file URL ACP attachments outside allowed inbound roots", async () => {
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
          coalesceIdleMs: 0,
          maxChunkChars: 64,
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
