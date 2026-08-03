// Qqbot tests cover outbound dispatch plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_MEDIA_SEND_ERROR,
  sendMedia,
  sendText,
  setOutboundAudioPort,
} from "../messaging/outbound.js";
import type { InboundContext } from "./inbound-context.js";
import { dispatchOutbound } from "./outbound-dispatch.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const sendVoiceMessageMock = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ id: "voice-1", timestamp: "2026-04-25T00:00:00.000Z" })),
);
const sendMediaMock = vi.hoisted(() =>
  vi.fn(
    async (
      _params: unknown,
    ): Promise<{ id: string; timestamp: string } | { channel: "qqbot"; error: string }> => ({
      id: "media-1",
      timestamp: "2026-04-25T00:00:00.000Z",
    }),
  ),
);
const sendTextMock = vi.hoisted(() =>
  vi.fn(async (..._params: unknown[]) => ({
    id: "text-1",
    timestamp: "2026-04-25T00:00:00.000Z",
  })),
);
const audioFileToSilkBase64Mock = vi.hoisted(() => vi.fn(async () => "silk-base64"));

vi.mock("../messaging/sender.js", async () => {
  // Real error class so prod `instanceof UploadDailyLimitExceededError` checks
  // in error paths don't trip vitest's missing-export guard on this mock.
  const { UploadDailyLimitExceededError } =
    await vi.importActual<typeof import("../api/media-chunked.js")>("../api/media-chunked.js");
  return {
    accountToCreds: (account: GatewayAccount) => ({
      appId: account.appId,
      clientSecret: account.clientSecret,
    }),
    buildDeliveryTarget: (target: { type: string; senderId: string; groupOpenid?: string }) => ({
      type: target.type === "group" ? "group" : target.type === "c2c" ? "c2c" : target.type,
      id: target.type === "group" ? target.groupOpenid : target.senderId,
    }),
    initApiConfig: vi.fn(),
    sendFileMessage: vi.fn(),
    sendImage: vi.fn(),
    sendText: sendTextMock,
    sendVideoMessage: vi.fn(),
    sendVoiceMessage: sendVoiceMessageMock,
    sendMedia: sendMediaMock,
    UploadDailyLimitExceededError,
    withTokenRetry: async (_creds: unknown, fn: () => Promise<unknown>) => await fn(),
  };
});

vi.mock("../utils/image-size.js", async () => {
  const actual =
    await vi.importActual<typeof import("../utils/image-size.js")>("../utils/image-size.js");
  return {
    ...actual,
    getImageSize: vi.fn(async () => ({ width: 640, height: 480 })),
  };
});

vi.mock("../utils/audio.js", () => ({
  audioFileToSilkBase64: audioFileToSilkBase64Mock,
}));

const account: GatewayAccount = {
  accountId: "qq-main",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

function makeInbound(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    event: {
      type: "c2c",
      senderId: "user-openid",
      messageId: "msg-1",
      content: "voice",
      timestamp: "2026-04-25T00:00:00.000Z",
    },
    route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main" },
    isGroupChat: false,
    peerId: "user-openid",
    qualifiedTarget: "qqbot:c2c:user-openid",
    fromAddress: "qqbot:c2c:user-openid",
    agentBody: "voice",
    body: "voice",
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
    uniqueVoicePaths: [],
    uniqueVoiceUrls: [],
    uniqueVoiceAsrReferTexts: [],
    voiceMediaTypes: [],
    hasAsrReferFallback: false,
    voiceTranscriptSources: [],
    commandAuthorized: false,
    blocked: false,
    skipped: false,
    typing: { keepAlive: null },
    ...overrides,
  };
}

function makeInboundRuntime(
  dispatchReplyWithBufferedBlockDispatcher: (params: unknown) => Promise<unknown>,
  onResolvedContext?: (ctx: Record<string, unknown>) => void,
  onResolvedTurn?: (turn: Record<string, unknown>) => void,
): GatewayPluginRuntime["channel"]["inbound"] {
  return {
    run: vi.fn(async (rawParams: unknown) => {
      const params = rawParams as {
        raw: unknown;
        adapter: {
          ingest: (raw: unknown) => unknown;
          resolveTurn: (...args: unknown[]) => unknown;
        };
      };
      const input = await params.adapter.ingest(params.raw);
      const turn = (await params.adapter.resolveTurn(
        input,
        {
          canStartAgentTurn: true,
          kind: "message",
        },
        {},
      )) as {
        cfg: unknown;
        ctxPayload: Record<string, unknown>;
        record?: Record<string, unknown>;
        dispatcherOptions?: Record<string, unknown>;
        delivery: { deliver: unknown; onError?: unknown };
        replyOptions?: unknown;
        replyResolver?: unknown;
      };
      onResolvedContext?.(turn.ctxPayload);
      onResolvedTurn?.(turn as unknown as Record<string, unknown>);
      return {
        dispatchResult: await dispatchReplyWithBufferedBlockDispatcher({
          ctx: turn.ctxPayload,
          cfg: turn.cfg,
          dispatcherOptions: {
            ...turn.dispatcherOptions,
            deliver: turn.delivery.deliver,
            onError: turn.delivery.onError,
          },
          replyOptions: turn.replyOptions,
          replyResolver: turn.replyResolver,
        }),
      };
    }),
  };
}

type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
};
type DeliverReply = (payload: ReplyPayload, info: { kind: string }) => Promise<void>;
interface DispatchOptions {
  deliver: DeliverReply;
  onSkip?: (
    payload: ReplyPayload,
    info: { kind: string; reason: "empty" | "silent" | "heartbeat" },
  ) => void;
  onSettled?: () => unknown;
  onFreshSettledDelivery?: () => unknown;
}
interface RuntimeOptions {
  onFinalize?: (ctx: Record<string, unknown>) => void;
  onTurn?: (turn: Record<string, unknown>) => void;
  isControlCommandMessage?: (text?: string, cfg?: unknown) => boolean;
  skipFreshSettledDelivery?: boolean;
  onDispatch?: (dispatcherOptions: DispatchOptions) => Promise<void>;
  onDeliver?: (deliver: DeliverReply) => Promise<void>;
}

function makeRuntime(params: RuntimeOptions): GatewayPluginRuntime {
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async (rawParams: unknown) => {
    const dispatcherOptions = (rawParams as { dispatcherOptions: DispatchOptions })
      .dispatcherOptions;
    if (params.onDispatch) {
      await params.onDispatch(dispatcherOptions);
    } else {
      await params.onDeliver?.(dispatcherOptions.deliver);
    }
    await dispatcherOptions.onSettled?.();
    if (!params.skipFreshSettledDelivery) {
      await dispatcherOptions.onFreshSettledDelivery?.();
    }
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  return {
    state: {
      openChannelIngressQueue: () => {
        throw new Error("unexpected durable ingress access");
      },
    },
    channel: {
      activity: { record: vi.fn() },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "qqbot:c2c:user-openid",
          accountId: "qq-main",
        })),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        finalizeInboundContext: vi.fn((rawCtx: Record<string, unknown>) => rawCtx),
        formatInboundEnvelope: vi.fn(() => "voice"),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw/qqbot-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      inbound: makeInboundRuntime(
        dispatchReplyWithBufferedBlockDispatcher,
        params.onFinalize,
        params.onTurn,
      ),
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
      commands: {
        isControlCommandMessage: params.isControlCommandMessage ?? (() => false),
      },
    },
    tts: {
      textToSpeech: vi.fn(async () => ({
        success: true,
        audioPath: "/tmp/openclaw-qqbot/tts.wav",
        provider: "test-tts",
        outputFormat: "wav",
      })),
    },
  };
}

async function runOutbound(
  params: {
    runtime?: RuntimeOptions;
    inbound?: InboundContext;
    cfg?: unknown;
    account?: GatewayAccount;
  } = {},
): Promise<GatewayPluginRuntime> {
  const runtime = makeRuntime(params.runtime ?? {});
  await dispatchOutbound(params.inbound ?? makeInbound(), {
    runtime,
    cfg: params.cfg ?? {},
    account: params.account ?? account,
  });
  return runtime;
}

async function withTempMedia(
  prefix: string,
  fileName: string,
  run: (media: { tmpRoot: string; filePath: string; realFilePath: string }) => Promise<void>,
): Promise<void> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const filePath = path.join(tmpRoot, fileName);
    await fs.writeFile(filePath, Buffer.from("report"));
    await run({ tmpRoot, filePath, realFilePath: await fs.realpath(filePath) });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

function expectLocalFileMediaSent(realFilePath: string): void {
  expect(sendMediaMock).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "file",
      source: { localPath: realFilePath },
      target: { id: "user-openid", type: "c2c" },
    }),
  );
}

describe("dispatchOutbound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOutboundAudioPort({
      audioFileToSilkBase64: audioFileToSilkBase64Mock,
      isAudioFile: (pathOrUrl) => /\.(wav|mp3|ogg|silk)$/i.test(pathOrUrl),
      shouldTranscodeVoice: () => true,
      waitForFile: vi.fn(async (filePath: string) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, Buffer.from("voice"));
        return 128;
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "uploads local media from scoped outbound media roots",
      prefix: "qqbot-scoped-media-",
      fileName: "report.docx",
      send: ({ filePath, tmpRoot }: { filePath: string; tmpRoot: string }) =>
        sendMedia({
          to: "qqbot:c2c:user-openid",
          text: "",
          mediaUrl: filePath,
          accountId: "qq-main",
          account,
          mediaAccess: { localRoots: [tmpRoot] },
        }),
    },
    {
      name: "uploads qqmedia text tags from scoped outbound media roots",
      prefix: "qqbot-scoped-media-",
      fileName: "tagged-report.docx",
      send: ({ filePath, tmpRoot }: { filePath: string; tmpRoot: string }) =>
        sendText({
          to: "qqbot:c2c:user-openid",
          text: `<qqmedia>${filePath}</qqmedia>`,
          accountId: "qq-main",
          account,
          mediaAccess: { localRoots: [tmpRoot] },
        }),
    },
    {
      name: "resolves relative media paths from the scoped outbound media workspace",
      prefix: "qqbot-scoped-workspace-",
      fileName: "relative-report.docx",
      send: ({ filePath, tmpRoot }: { filePath: string; tmpRoot: string }) =>
        sendMedia({
          to: "qqbot:c2c:user-openid",
          text: "",
          mediaUrl: path.basename(filePath),
          accountId: "qq-main",
          account,
          mediaAccess: { localRoots: [tmpRoot], workspaceDir: tmpRoot },
        }),
    },
  ])("$name", async ({ prefix, fileName, send }) => {
    await withTempMedia(prefix, fileName, async (media) => {
      const result = await send(media);
      expect(result.error).toBeUndefined();
      expectLocalFileMediaSent(media.realFilePath);
    });
  });

  it("loads scoped media through host read callbacks", async () => {
    // macOS tmpdir is a /var -> /private/var symlink; containment compares canonical roots.
    const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-host-read-")));
    try {
      const mediaPath = path.join(tmpRoot, "host-report.txt");
      const mediaReadFile = vi.fn(async () => Buffer.from("host report"));
      const result = await sendMedia({
        to: "qqbot:c2c:user-openid",
        text: "",
        mediaUrl: "host-report.txt",
        accountId: "qq-main",
        account,
        mediaAccess: { localRoots: [tmpRoot], workspaceDir: tmpRoot, readFile: mediaReadFile },
      });

      expect(result.error).toBeUndefined();
      expect(mediaReadFile).toHaveBeenCalledWith(mediaPath);
      expect(sendMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "file",
          source: expect.objectContaining({
            buffer: Buffer.from("host report"),
            fileName: "host-report.txt",
          }),
          target: { id: "user-openid", type: "c2c" },
        }),
      );
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("lets missing voice files inside scoped outbound roots reach the voice wait path", async () => {
    // Missing-path resolution joins canonical roots, so keep macOS tmpdir canonical here.
    const tmpRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-scoped-voice-")),
    );
    try {
      const missingVoicePath = path.join(tmpRoot, "pending.wav");
      await runOutbound({
        runtime: {
          onDeliver: async (deliver) => {
            await deliver({ text: `<qqvoice>${missingVoicePath}</qqvoice>` }, { kind: "block" });
          },
        },
        inbound: makeInbound({
          route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main", agentId: "agent-1" },
        }),
        cfg: { agents: { list: [{ id: "agent-1", workspace: tmpRoot }] } },
      });
      expect(audioFileToSilkBase64Mock).toHaveBeenCalledWith(missingVoicePath, undefined);
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  const mediaTestNames = {
    tagPath: "threads agent scoped media roots through gateway qqmedia block replies",
    tagRelative: "resolves relative gateway qqmedia block replies against the agent workspace",
    urlRelative: "resolves relative block mediaUrl payloads against the agent workspace",
    main: "resolves default main route mediaUrl payloads against the main agent workspace",
    defaultAgent:
      "resolves missing route agent mediaUrl payloads against the configured default agent workspace",
    tagVirtual: "maps sandbox /workspace qqmedia block replies to the agent workspace",
    tool: "threads agent scoped media roots through gateway tool media forwarding",
    payload: "threads agent scoped media roots through gateway QQBOT_PAYLOAD replies",
    payloadVirtual: "maps sandbox /workspace QQBOT_PAYLOAD media paths to the agent workspace",
    stream: "threads agent scoped media roots through official C2C streaming media tags",
  } as const;
  const workspaceMediaCases = [
    [mediaTestNames.tagPath, "gateway-report.docx", "tag-path", "agent"],
    [mediaTestNames.tagRelative, "relative-report.docx", "tag-relative", "agent"],
    [mediaTestNames.urlRelative, "relative-report.docx", "url-relative", "agent"],
    [mediaTestNames.main, "main-report.docx", "url-relative", "main"],
    [mediaTestNames.defaultAgent, "default-report.docx", "url-relative", "default"],
    [mediaTestNames.tagVirtual, "sandbox-report.docx", "tag-virtual", "agent"],
    [mediaTestNames.tool, "tool-report.docx", "tool-path", "agent"],
    [mediaTestNames.payload, "payload-report.pdf", "payload-path", "agent"],
    [mediaTestNames.payloadVirtual, "payload-workspace-report.pdf", "payload-virtual", "agent"],
    [mediaTestNames.stream, "stream-report.docx", "tag-path", "agent-stream"],
  ] as const;

  async function deliverWorkspaceMedia(
    mode: (typeof workspaceMediaCases)[number][2],
    deliver: DeliverReply,
    filePath: string,
  ): Promise<void> {
    if (mode === "tool-path") {
      await deliver({ text: "final answer" }, { kind: "block" });
      await deliver({ mediaUrl: filePath }, { kind: "tool" });
      return;
    }
    if (mode === "url-relative") {
      await deliver({ mediaUrl: path.basename(filePath) }, { kind: "block" });
      return;
    }
    const text =
      mode === "tag-path"
        ? `<qqmedia>${filePath}</qqmedia>`
        : mode === "tag-relative"
          ? `<qqmedia>${path.basename(filePath)}</qqmedia>`
          : mode === "tag-virtual"
            ? `<qqmedia>/workspace/${path.basename(filePath)}</qqmedia>`
            : `QQBOT_PAYLOAD:${JSON.stringify({
                type: "media",
                mediaType: "file",
                source: "file",
                path: mode === "payload-path" ? filePath : `/workspace/${path.basename(filePath)}`,
              })}`;
    await deliver({ text }, { kind: "block" });
  }

  it.each(workspaceMediaCases)("%s", async (_, fileName, mode, routeKind) => {
    const agentId =
      routeKind === "main" ? "main" : routeKind === "default" ? "assistant" : "agent-1";
    const routed = routeKind === "agent" || routeKind === "agent-stream";
    const isDefault = routeKind === "default";
    const streaming = routeKind === "agent-stream";
    await withTempMedia("qqbot-workspace-media-", fileName, async (media) => {
      let finalized: Record<string, unknown> | undefined;
      const runtime = await runOutbound({
        runtime: {
          onFinalize: (ctx) => (finalized = ctx),
          onDeliver: (deliver) => deliverWorkspaceMedia(mode, deliver, media.filePath),
        },
        inbound: routed
          ? makeInbound({
              route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main", agentId },
            })
          : makeInbound(),
        cfg: {
          agents: {
            list: [
              {
                id: agentId,
                ...(isDefault ? { default: true } : {}),
                workspace: media.tmpRoot,
              },
            ],
          },
        },
        account: streaming
          ? { ...account, config: { streaming: { mode: "partial", nativeTransport: true } } }
          : account,
      });

      expectLocalFileMediaSent(media.realFilePath);
      if (isDefault) {
        expect(runtime.channel.reply.resolveEffectiveMessagesConfig).toHaveBeenCalledWith(
          expect.anything(),
          agentId,
        );
        expect(finalized?.AgentId).toBe(agentId);
      }
    });
  });

  it("blocks sandbox /workspace qqmedia paths that escape the agent workspace", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qqbot-agent-virtual-root-"));
    try {
      const workspaceDir = path.join(tmpRoot, "workspace");
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(tmpRoot, "outside-report.docx"), Buffer.from("outside"));
      await runOutbound({
        runtime: {
          onDeliver: async (deliver) => {
            await deliver(
              { text: "<qqmedia>/workspace/../outside-report.docx</qqmedia>" },
              { kind: "block" },
            );
          },
        },
        inbound: makeInbound({
          route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main", agentId: "agent-1" },
        }),
        cfg: { agents: { list: [{ id: "agent-1", workspace: workspaceDir }] } },
      });

      expect(sendMediaMock).not.toHaveBeenCalled();
      expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([DEFAULT_MEDIA_SEND_ERROR]);
      const sentText = String(sendTextMock.mock.calls[0]?.[1]);
      expect(sentText).not.toContain("<qqmedia>");
      expect(sentText).not.toContain("/workspace/../outside-report.docx");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("sends sanitized fallback when media-only block payload forwarding fails", async () => {
    sendMediaMock.mockResolvedValueOnce({ channel: "qqbot", error: "upload failed" });
    await runOutbound({
      runtime: {
        onDeliver: async (deliver) => {
          await deliver({ mediaUrl: "missing-report.pdf" }, { kind: "block" });
        },
      },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([DEFAULT_MEDIA_SEND_ERROR]);
    const sentText = String(sendTextMock.mock.calls[0]?.[1]);
    expect(sentText).not.toContain("missing-report.pdf");
  });

  it("does not expose default sandbox roots through gateway qqmedia replies", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "qqbot-agent-root-boundary-",
    });
    try {
      const workspaceDir = path.join(openClawState.root, "workspace");
      const stateSandboxDir = openClawState.statePath("sandboxes", "other-agent");
      const stateSandboxFile = path.join(stateSandboxDir, "outside-report.docx");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(stateSandboxDir, { recursive: true });
      await fs.writeFile(stateSandboxFile, Buffer.from("outside"));
      await runOutbound({
        runtime: {
          onDeliver: async (deliver) => {
            await deliver({ text: `<qqmedia>${stateSandboxFile}</qqmedia>` }, { kind: "block" });
          },
        },
        inbound: makeInbound({
          route: { sessionKey: "qqbot:c2c:user-openid", accountId: "qq-main", agentId: "agent-1" },
        }),
        cfg: { agents: { list: [{ id: "agent-1", workspace: workspaceDir }] } },
      });
      expect(sendMediaMock).not.toHaveBeenCalled();
    } finally {
      await openClawState.cleanup();
    }
  });

  it.each([
    {
      name: "keeps waiting past 300s when a slow provider timeout is configured",
      text: "late answer",
      cfg: { models: { providers: { ollama: { timeoutSeconds: 1800 } } } },
      durable: false,
    },
    {
      name: "keeps durable settlement with a dispatch that outlives the response watchdog",
      text: "late durable answer",
      cfg: {},
      durable: true,
    },
  ])("$name", async ({ text, cfg, durable }) => {
    vi.useFakeTimers();
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
    };
    const inbound = makeInbound();
    if (durable) {
      inbound.event.turnAdoptionLifecycle = lifecycle;
    }
    const runtime = makeRuntime({
      onDeliver: async (deliver) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 301_000);
        });
        await deliver({ text }, { kind: "block" });
      },
    });
    let settled = false;
    const dispatchPromise = dispatchOutbound(inbound, { runtime, cfg, account }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);
    if (durable) {
      expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    } else {
      expect(sendTextMock).not.toHaveBeenCalled();
    }

    await vi.advanceTimersByTimeAsync(1_000);
    await dispatchPromise;
    expect(sendTextMock).toHaveBeenCalledWith(
      expect.anything(),
      text,
      expect.anything(),
      expect.anything(),
    );
  });

  it("marks voice-only inbound as type-only audio facts", async () => {
    let finalized: Record<string, unknown> | undefined;
    await runOutbound({
      runtime: { onFinalize: (ctx) => (finalized = ctx) },
      inbound: makeInbound({
        uniqueVoicePaths: ["/tmp/qqbot/voice.wav"],
        voiceMediaTypes: ["audio/wav"],
      }),
    });

    expect(finalized?.media).toEqual([expect.objectContaining({ contentType: "audio/wav" })]);
    expect(finalized?.QQVoiceAttachmentPaths).toEqual(["/tmp/qqbot/voice.wav"]);
    expect(finalized?.MediaPath).toBeUndefined();
    expect(finalized?.MediaPaths).toBeUndefined();
  });

  it("keeps disjoint local and remote images as separate ordered facts", async () => {
    let finalized: Record<string, unknown> | undefined;
    await runOutbound({
      runtime: { onFinalize: (ctx) => (finalized = ctx) },
      inbound: makeInbound({
        localMediaPaths: ["/tmp/qqbot/local.png"],
        localMediaTypes: ["image/png"],
        remoteMediaUrls: ["https://example.test/remote.png"],
      }),
    });

    expect(finalized?.media).toEqual([
      expect.objectContaining({
        path: "/tmp/qqbot/local.png",
        contentType: "image/png",
        kind: "image",
      }),
      // Remote URLs carry no MIME; the explicit kind preserves image understanding.
      expect.objectContaining({ url: "https://example.test/remote.png", kind: "image" }),
    ]);
  });

  it("synthesizes plain audioAsVoice text as a QQ voice reply", async () => {
    const runtime = await runOutbound({
      runtime: {
        onDeliver: async (deliver) => {
          await deliver({ text: "read this aloud", audioAsVoice: true }, { kind: "block" });
        },
      },
    });

    expect(runtime.tts.textToSpeech).toHaveBeenCalledWith({
      text: "read this aloud",
      cfg: {},
      channel: "qqbot",
      accountId: "qq-main",
    });
    expect(audioFileToSilkBase64Mock).toHaveBeenCalledWith("/tmp/openclaw-qqbot/tts.wav");
    const sentMedia = sendMediaMock.mock.calls.at(0)?.[0] as
      | { kind?: string; source?: unknown; msgId?: string; ttsText?: string }
      | undefined;
    expect(sentMedia?.kind).toBe("voice");
    expect(sentMedia?.source).toEqual({ base64: "silk-base64" });
    expect(sentMedia?.msgId).toBe("msg-1");
    expect(sentMedia?.ttsText).toBe("read this aloud");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "delivers text-only tool progress immediately in partial streaming mode",
      streaming: { mode: "partial" as const },
    },
    {
      name: "delivers text-only tool progress immediately in recommended C2C streaming mode",
      streaming: { mode: "partial" as const, nativeTransport: true },
    },
    {
      name: "delivers text-only tool progress when nativeTransport is on despite mode off",
      streaming: { mode: "off" as const, nativeTransport: true },
    },
  ])("$name", async ({ streaming }) => {
    await runOutbound({
      runtime: {
        onDeliver: async (deliver) => {
          await deliver({ text: "Working: checking logs" }, { kind: "tool" });
          await deliver({ text: "final answer" }, { kind: "block" });
        },
      },
      account: { ...account, config: { streaming } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps immediate tool progress media-like text inert with markdown support enabled", async () => {
    const progress = "progress ![x](http://internal.example/progress.png)";
    await runOutbound({
      runtime: {
        onDeliver: async (deliver) => {
          await deliver({ text: progress }, { kind: "tool" });
          await deliver({ text: "final answer" }, { kind: "block" });
        },
      },
      account: { ...account, markdownSupport: true, config: { streaming: { mode: "partial" } } },
    });

    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([progress, "final answer"]);
    expect(sendTextMock.mock.calls[0]?.[3]).toMatchObject({ forcePlainText: true });
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps text-only tool progress buffered when streaming is off", async () => {
    await runOutbound({
      runtime: {
        onDeliver: async (deliver) => {
          await deliver({ text: "Working: checking logs" }, { kind: "tool" });
          await deliver({ text: "final answer" }, { kind: "block" });
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["final answer"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("flushes buffered tool text when non-streaming final block is silent", async () => {
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver, onSkip }) => {
          await deliver({ text: "first visible tool message" }, { kind: "tool" });
          await deliver({ text: "second visible tool message" }, { kind: "tool" });
          onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
        },
      },
      inbound: makeInbound({
        event: {
          type: "group",
          senderId: "member-openid",
          messageId: "msg-group-tool-final-silent",
          content: "<@BOT> do it",
          timestamp: "2026-04-25T00:00:00.000Z",
          groupOpenid: "group-openid",
        },
        route: { sessionKey: "qqbot:group:group-openid", accountId: "qq-main" },
        isGroupChat: true,
        peerId: "group-openid",
        qualifiedTarget: "qqbot:group:group-openid",
        fromAddress: "qqbot:group:group-openid",
        agentBody: "do it",
        body: "[member-openid] do it (@you)",
      }),
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "first visible tool message",
      "second visible tool message",
    ]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("keeps buffered tool text suppressed when a visible block precedes a silent final skip", async () => {
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver, onSkip }) => {
          await deliver({ text: "Working: checking logs" }, { kind: "tool" });
          onSkip?.({ text: "NO_REPLY" }, { kind: "final", reason: "silent" });
          await deliver({ text: "final answer" }, { kind: "block" });
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["final answer"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("does not re-send tool fallback after timeout when non-streaming final block is silent", async () => {
    vi.useFakeTimers();
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver, onSkip }) => {
          await deliver({ text: "visible tool message" }, { kind: "tool" });
          await vi.advanceTimersByTimeAsync(60_000);
          onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool message"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("waits for fresh settled delivery after a skipped silent block", async () => {
    vi.useFakeTimers();
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver, onSkip }) => {
          await deliver({ text: "visible tool message" }, { kind: "tool" });
          onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
          await vi.advanceTimersByTimeAsync(60_000);
          expect(sendTextMock).not.toHaveBeenCalled();
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool message"]);
    expect(sendMediaMock).not.toHaveBeenCalled();
  });

  it("does not send stale tool fallback when fresh settled delivery is suppressed", async () => {
    vi.useFakeTimers();
    await runOutbound({
      runtime: {
        skipFreshSettledDelivery: true,
        onDispatch: async ({ deliver, onSkip }) => {
          await deliver({ text: "stale visible tool message" }, { kind: "tool" });
          onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendMediaMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends buffered tool text when tool media fallback fails", async () => {
    vi.useFakeTimers();
    sendMediaMock.mockResolvedValueOnce({ channel: "qqbot", error: "upload failed" });
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver }) => {
          await deliver({ mediaUrl: "https://example.com/progress.png" }, { kind: "tool" });
          await deliver({ text: "visible tool fallback" }, { kind: "tool" });
          await vi.advanceTimersByTimeAsync(60_000);
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendMediaMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool fallback"]);
  });

  it("bounds tool media flushes without racing the fallback timer", async () => {
    vi.useFakeTimers();
    sendMediaMock.mockImplementationOnce(() => new Promise(() => {}));
    sendMediaMock.mockImplementationOnce(() => new Promise(() => {}));
    const runtime = makeRuntime({
      onDispatch: async ({ deliver, onSkip }) => {
        await deliver({ mediaUrl: "https://example.com/progress-1.png" }, { kind: "tool" });
        await deliver({ mediaUrl: "https://example.com/progress-2.png" }, { kind: "tool" });
        await deliver({ text: "visible tool message" }, { kind: "tool" });
        onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
      },
    });
    const dispatchPromise = dispatchOutbound(makeInbound(), {
      runtime,
      cfg: {},
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await dispatchPromise;
    expect(sendMediaMock).toHaveBeenCalledTimes(2);
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual(["visible tool message"]);
  });

  it("clears the media timeout after a successful silent-final flush", async () => {
    vi.useFakeTimers();
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver, onSkip }) => {
          await deliver({ mediaUrl: "https://example.com/progress.png" }, { kind: "tool" });
          onSkip?.({ text: "NO_REPLY" }, { kind: "block", reason: "silent" });
        },
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendMediaMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: "empty text", payload: {} },
    { name: "silent token", payload: { text: "NO_REPLY" } },
  ])("delivers media-only non-streaming final block replies with $name", async ({ payload }) => {
    const mediaUrl = "https://example.com/final.png";
    await runOutbound({
      runtime: {
        onDeliver: async (deliver) => deliver({ ...payload, mediaUrl }, { kind: "block" }),
      },
      account: { ...account, config: { streaming: { mode: "off" } } },
    });
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith({
      creds: { appId: "app", clientSecret: "secret" },
      kind: "image",
      msgId: "msg-1",
      source: { url: mediaUrl },
      target: { id: "user-openid", type: "c2c" },
    });
  });

  it("delivers media-only final block replies when C2C streaming is enabled", async () => {
    const mediaUrl = "https://example.com/final.png";
    await runOutbound({
      runtime: { onDeliver: async (deliver) => deliver({ mediaUrl }, { kind: "block" }) },
      account: { ...account, config: { streaming: { mode: "partial", nativeTransport: true } } },
    });
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendMediaMock).toHaveBeenCalledWith({
      creds: { appId: "app", clientSecret: "secret" },
      kind: "image",
      msgId: "msg-1",
      source: { url: mediaUrl },
      target: { id: "user-openid", type: "c2c" },
    });
  });

  it("renews pending tool-media fallback when partial progress is delivered", async () => {
    vi.useFakeTimers();
    const mediaUrl = "https://example.com/progress.png";
    await runOutbound({
      runtime: {
        onDeliver: async (deliver) => {
          await deliver({ mediaUrl }, { kind: "tool" });
          await vi.advanceTimersByTimeAsync(59_000);
          await deliver({ text: "Working: checking logs" }, { kind: "tool" });
          await vi.advanceTimersByTimeAsync(1_000);
          expect(sendMediaMock).not.toHaveBeenCalled();
          await deliver({ text: "final answer" }, { kind: "block" });
        },
      },
      account: { ...account, config: { streaming: { mode: "partial" } } },
    });
    expect(sendTextMock.mock.calls.map((call) => call[1])).toEqual([
      "Working: checking logs",
      "final answer",
    ]);
    expect(sendMediaMock).toHaveBeenCalledTimes(1);
  });

  it("marks recognized C2C framework slash commands as text commands", async () => {
    let finalized: Record<string, unknown> | undefined;
    const runtime = makeRuntime({
      isControlCommandMessage: (text) => text === "/models",
      onFinalize: (ctx) => (finalized = ctx),
    });

    await dispatchOutbound(
      makeInbound({
        event: {
          type: "c2c",
          senderId: "user-openid",
          messageId: "msg-models",
          content: "/models",
          timestamp: "2026-04-25T00:00:00.000Z",
        },
        agentBody: "/models",
        body: "/models",
        commandAuthorized: true,
      }),
      { runtime, cfg: { commands: { text: true } }, account },
    );

    expect(finalized?.CommandBody).toBe("/models");
    expect(finalized?.CommandAuthorized).toBe(true);
    expect(finalized?.CommandSource).toBe("text");
    expect(finalized?.Provider).toBe("qqbot");
    expect(finalized?.Surface).toBe("qqbot");
    expect(finalized?.ChatType).toBe("direct");
  });

  it.each([
    {
      name: "keeps markdown table chunks self-contained across block deliveries",
      blocks: [
        ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
        ["| 2 | beta |", "| 3 | gamma |"].join("\n"),
      ],
      expected: [
        ["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n"),
        ["| Id | Value |", "|---:|---|", "| 2 | beta |", "| 3 | gamma |"].join("\n"),
      ],
      assertEach: true,
    },
    {
      name: "waits for a table separator when a block ends after the header",
      blocks: ["| Id | Value |", ["|---:|---|", "| 1 | alpha |"].join("\n")],
      expected: [["| Id | Value |", "|---:|---|", "| 1 | alpha |"].join("\n")],
    },
    {
      name: "flushes unfinished markdown table row fragments as plain text fields",
      blocks: [
        ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
        "| 10 | analyzeerror_patterns | 无需重试",
      ],
      expected: [
        ["| Id | Function | Status |", "|---:|---|---|", "| 1 | auth | ok |"].join("\n"),
        ["Id: 10", "Function: analyzeerror_patterns", "Status: 无需重试"].join("\n"),
      ],
    },
    {
      name: "holds short table rows until a following block completes the columns",
      blocks: [
        [
          "| Id | Time | Owner | Note |",
          "|---:|---|---|---|",
          "| 16 | 40ms | He | ok |",
          "| 17 | 100ms |",
        ].join("\n"),
        "Lin | daily cap |",
      ],
      expected: [
        ["| Id | Time | Owner | Note |", "|---:|---|---|---|", "| 16 | 40ms | He | ok |"].join(
          "\n",
        ),
        [
          "| Id | Time | Owner | Note |",
          "|---:|---|---|---|",
          "| 17 | 100ms | Lin | daily cap |",
        ].join("\n"),
      ],
    },
  ])("$name", async ({ blocks, expected, assertEach }) => {
    await runOutbound({
      runtime: {
        onDispatch: async ({ deliver }) => {
          for (const text of blocks) {
            await deliver({ text }, { kind: "block" });
          }
        },
      },
    });

    const sentTexts = sendTextMock.mock.calls.map((call) => call[1]);
    if (assertEach) {
      expect(sendTextMock).toHaveBeenCalledTimes(2);
      expect(sentTexts[0]).toBe(expected[0]);
      expect(sentTexts[1]).toBe(expected[1]);
    } else {
      expect(sentTexts).toEqual(expected);
    }
  });

  it("persists announce routes only for group and guild turns", async () => {
    const cases = [
      ["group", true, { groupOpenid: "group-1001" }, "group-1001", "qqbot:group:group-1001"],
      [
        "guild",
        true,
        { channelId: "channel-2001", guildId: "guild-2001" },
        "channel-2001",
        "qqbot:channel:channel-2001",
      ],
      ["c2c", false, {}, "user-openid", "qqbot:c2c:user-openid"],
      ["dm", false, { guildId: "dm-guild-1" }, "user-openid", "qqbot:dm:dm-guild-1"],
    ] as const;

    for (const [type, isGroupChat, eventTarget, peerId, qualifiedTarget] of cases) {
      let record: Record<string, unknown> | undefined;
      const sessionKey = `agent:main:qqbot:${type}:${peerId}`;
      await runOutbound({
        runtime: {
          onTurn: (turn) => {
            record = turn.record as Record<string, unknown> | undefined;
          },
          onDeliver: async (deliver) => {
            await deliver({ text: "hello" }, { kind: "block" });
          },
        },
        inbound: makeInbound({
          event: {
            type,
            senderId: "user-openid",
            messageId: `msg-${type}`,
            content: "hello",
            timestamp: "2026-04-25T00:00:00.000Z",
            ...eventTarget,
          } as InboundContext["event"],
          isGroupChat,
          peerId,
          qualifiedTarget,
          route: { sessionKey, accountId: "qq-main" },
        }),
      });

      expect(record).toBeDefined();
      expect(record?.updateLastRoute).toEqual(
        isGroupChat
          ? { sessionKey, channel: "qqbot", to: qualifiedTarget, accountId: "qq-main" }
          : undefined,
      );
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
