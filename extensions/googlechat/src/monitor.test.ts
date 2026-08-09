// Googlechat tests cover monitor plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  createGoogleChatIngressMonitor,
  type GoogleChatIngressLifecycle,
} from "./monitor-ingress.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

const routingMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  buildEnvelope: vi.fn(({ body }: { body: string }) => body),
  resolveChannelInboundRouteEnvelope: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    resolveChannelInboundRouteEnvelope: inboundMocks.resolveChannelInboundRouteEnvelope,
  };
});

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: apiMocks.deleteGoogleChatMessage,
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
  updateGoogleChatMessage: apiMocks.updateGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(
    (
      processEvent: (
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>,
    ) => {
      routingMocks.processEvent = processEvent;
    },
  ),
}));

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset();
  apiMocks.updateGoogleChatMessage.mockReset();
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
  inboundMocks.buildEnvelope.mockReset().mockImplementation(({ body }: { body: string }) => body);
  inboundMocks.resolveChannelInboundRouteEnvelope
    .mockReset()
    .mockImplementation(({ accountId }: { accountId: string }) => ({
      route: {
        agentId: "agent-1",
        accountId,
        sessionKey: "session-1",
      },
      buildEnvelope: inboundMocks.buildEnvelope,
    }));
});

function createInboundClassificationHarness() {
  const buildContext = vi.fn((payload: unknown) => payload);
  const runTurn = vi.fn();
  const saveMediaBuffer = vi.fn(async () => ({
    path: "/tmp/googlechat-first.png",
    contentType: "image/png",
  }));
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext, run: runTurn },
      media: { saveMediaBuffer },
    },
  } as unknown as GoogleChatCoreRuntime;
  return { buildContext, core, runTurn, saveMediaBuffer };
}

function readGoogleChatTestIngest(runTurn: ReturnType<typeof vi.fn>) {
  const runArg = runTurn.mock.calls[0]?.[0] as
    | { adapter?: { ingest?: () => Record<string, string> } }
    | undefined;
  return runArg?.adapter?.ingest?.();
}

const googleChatMediaTestAccount: ResolvedGoogleChatAccount = {
  accountId: "work",
  enabled: true,
  config: { typingIndicator: "none" },
  credentialSource: "inline",
};

function createGoogleChatMediaTestEvent(params: {
  id: string;
  text?: string;
  attachments?: NonNullable<GoogleChatEvent["message"]>["attachment"];
}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/MEDIA", type: "DM" },
    message: {
      name: `spaces/MEDIA/messages/${params.id}`,
      ...(params.text === undefined ? {} : { text: params.text }),
      sender: { name: "users/alice", type: "HUMAN" },
      ...(params.attachments ? { attachment: params.attachments } : {}),
    },
  };
}

function allowGoogleChatMediaSender(commandAuthorized?: boolean) {
  accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
    ok: true,
    commandAuthorized,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
}

async function processGoogleChatTestEvent(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: Record<string, unknown>;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  mediaMaxMb: number;
  turnAdoptionLifecycle?: GoogleChatIngressLifecycle;
}): Promise<void> {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(
    params.event,
    {
      account: params.account,
      config: params.config,
      runtime: params.runtime,
      core: params.core,
      mediaMaxMb: params.mediaMaxMb,
      path: "/googlechat",
    },
    params.turnAdoptionLifecycle,
  );
}

describe("googlechat monitor bot loop protection", () => {
  it("suppresses bot loops before creating typing messages", async () => {
    const eventTimeMs = Date.parse("2026-03-22T00:00:00.000Z");
    const accountId = `bot-loop-typing-${eventTimeMs}`;
    const conversationId = "spaces/LOOP";
    const senderId = "users/other-bot";
    const receiverId = "users/app";
    const runTurn = vi.fn();
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        inbound: { run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId,
      config: {
        allowBots: true,
        botUser: receiverId,
        botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: conversationId, type: "DM" },
      message: {
        name: "spaces/LOOP/messages/2",
        text: "loop",
        sender: { name: senderId, type: "BOT" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    recordChannelBotPairLoopAndCheckSuppression({
      scopeId: accountId,
      conversationId,
      senderId,
      receiverId,
      config: account.config.botLoopProtection,
      defaultEnabled: true,
      nowMs: eventTimeMs,
    });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("googlechat monitor inbound space classification", () => {
  const cases = [
    { name: "legacy DM", space: { type: "DM" }, peerKind: "direct" },
    { name: "modern direct message", space: { spaceType: "DIRECT_MESSAGE" }, peerKind: "direct" },
    { name: "single-user bot DM", space: { singleUserBotDm: true }, peerKind: "direct" },
    { name: "modern space", space: { spaceType: "SPACE" }, peerKind: "group" },
    { name: "modern group chat", space: { spaceType: "GROUP_CHAT" }, peerKind: "group" },
    {
      name: "modern space over legacy DM",
      space: { type: "DM", spaceType: "SPACE" },
      peerKind: "group",
    },
  ] as const;

  it.each(cases)("$name uses the expected access and route branch", async ({ space, peerKind }) => {
    const { buildContext, core, runTurn } = createInboundClassificationHarness();
    const account = {
      accountId: "work",
      config: {},
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      space: { name: "spaces/CLASSIFY", ...space },
      message: {
        name: "spaces/CLASSIFY/messages/1",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    const isGroup = peerKind === "group";
    expect(accessMocks.applyGoogleChatInboundAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ isGroup }),
    );
    expect(inboundMocks.resolveChannelInboundRouteEnvelope).toHaveBeenCalledWith({
      cfg: {},
      channel: "googlechat",
      accountId: "work",
      peer: { kind: peerKind, id: "spaces/CLASSIFY" },
    });
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({ kind: isGroup ? "channel" : "direct" }),
        extra: expect.objectContaining({ ChatType: isGroup ? "channel" : "direct" }),
      }),
    );
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("keeps media-only text empty and carries every native attachment fact", async () => {
    const { buildContext, core, runTurn, saveMediaBuffer } = createInboundClassificationHarness();
    apiMocks.downloadGoogleChatMedia.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
    });
    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event: {
        type: "MESSAGE",
        space: { name: "spaces/MEDIA", type: "DM" },
        message: {
          name: "spaces/MEDIA/messages/1",
          sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
          attachment: [
            {
              contentType: "image/png",
              contentName: "first.png",
              attachmentDataRef: { resourceName: "media/first" },
            },
            { contentType: "application/pdf", contentName: "second.pdf" },
          ],
        },
      },
      account: {
        accountId: "work",
        config: { typingIndicator: "none" },
        credentialSource: "inline",
      } as ResolvedGoogleChatAccount,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    expect(accessMocks.applyGoogleChatInboundAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ rawBody: "" }),
    );
    expect(saveMediaBuffer).toHaveBeenCalledOnce();
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { body: "", bodyForAgent: "", rawBody: "", commandBody: "" },
        media: [
          expect.objectContaining({
            path: "/tmp/googlechat-first.png",
            url: "/tmp/googlechat-first.png",
            contentType: "image/png",
          }),
          expect.objectContaining({ contentType: "application/pdf" }),
        ],
      }),
    );
    expect(readGoogleChatTestIngest(runTurn)).toMatchObject({
      rawText: "",
      textForAgent: "",
      textForCommands: "",
    });
  });

  it.each([
    { name: "a caption", text: "please summarize this" },
    { name: "no caption", text: "" },
  ])("keeps $name and every attachment fact when the first file is oversized", async ({ text }) => {
    const { buildContext, core, runTurn, saveMediaBuffer } = createInboundClassificationHarness();
    const runtime = { error: vi.fn(), log: vi.fn() };
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
      abortSignal: new AbortController().signal,
    } satisfies GoogleChatIngressLifecycle;
    apiMocks.downloadGoogleChatMedia.mockRejectedValue(
      new MediaFetchError("max_bytes", "Google Chat media exceeds max bytes (10485760)"),
    );
    allowGoogleChatMediaSender(true);
    runTurn.mockImplementation(
      async (params: { turnAdoptionLifecycle?: GoogleChatIngressLifecycle }) => {
        await params.turnAdoptionLifecycle?.onAdopted();
      },
    );

    await processGoogleChatTestEvent({
      event: createGoogleChatMediaTestEvent({
        id: "oversized",
        text,
        attachments: [
          {
            contentType: "application/pdf",
            contentName: "untrusted-filename.pdf",
            attachmentDataRef: { resourceName: "media/oversized" },
          },
          { contentType: "image/png", contentName: "second.png" },
        ],
      }),
      account: googleChatMediaTestAccount,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
      turnAdoptionLifecycle,
    });

    const notice = "[Google Chat attachment too large; maximum 10 MB]";
    const expectedBody = text ? `${text}\n\n${notice}` : notice;
    expect(accessMocks.applyGoogleChatInboundAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ rawBody: text }),
    );
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          body: expectedBody,
          bodyForAgent: expectedBody,
          rawBody: expectedBody,
          commandBody: expectedBody,
        },
        media: [
          expect.objectContaining({ contentType: "application/pdf", kind: "document" }),
          expect.objectContaining({ contentType: "image/png", kind: "image" }),
        ],
      }),
    );
    expect(JSON.stringify(buildContext.mock.calls[0]?.[0])).not.toContain("untrusted-filename.pdf");
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("channels.googlechat.mediaMaxMb"),
    );
    expect(turnAdoptionLifecycle.onAdopted).toHaveBeenCalledOnce();
    expect(readGoogleChatTestIngest(runTurn)).toMatchObject({
      rawText: expectedBody,
      textForAgent: expectedBody,
      textForCommands: expectedBody,
    });
  });

  it.each([
    {
      name: "a transient fetch failure",
      error: new MediaFetchError("fetch_failed", "socket reset"),
    },
    {
      name: "a retryable HTTP failure",
      error: new MediaFetchError("http_error", "Google Chat API 503: unavailable", { status: 503 }),
    },
    { name: "an untyped download failure", error: new Error("temporary download failure") },
  ])("keeps $name retryable", async ({ error }) => {
    const { core, runTurn } = createInboundClassificationHarness();
    apiMocks.downloadGoogleChatMedia.mockRejectedValue(error);
    allowGoogleChatMediaSender();

    await expect(
      processGoogleChatTestEvent({
        event: createGoogleChatMediaTestEvent({
          id: "retryable",
          text: "please summarize this",
          attachments: [
            {
              contentType: "application/pdf",
              attachmentDataRef: { resourceName: "media/retryable" },
            },
          ],
        }),
        account: googleChatMediaTestAccount,
        config: {},
        runtime: { error: vi.fn(), log: vi.fn() },
        core,
        mediaMaxMb: 10,
      }),
    ).rejects.toBe(error);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("adopts an oversized attachment so the next message in its durable lane can run", async () => {
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-googlechat-oversized-"));
    const stateDir = await fs.realpath(created);
    const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
      channelId: "googlechat",
      accountId: "work",
      stateDir,
    });
    const { buildContext, core, runTurn } = createInboundClassificationHarness();
    const runtime = { error: vi.fn(), log: vi.fn() };
    const account = googleChatMediaTestAccount;
    const receivedBodies: string[] = [];
    apiMocks.downloadGoogleChatMedia.mockRejectedValueOnce(
      new MediaFetchError("max_bytes", "Google Chat media exceeds max bytes (10485760)"),
    );
    allowGoogleChatMediaSender();
    runTurn.mockImplementation(
      async (params: { turnAdoptionLifecycle?: GoogleChatIngressLifecycle }) => {
        const context = buildContext.mock.calls.at(-1)?.[0] as { message: { rawBody: string } };
        receivedBodies.push(context.message.rawBody);
        await params.turnAdoptionLifecycle?.onAdopted();
      },
    );
    const ingress = createGoogleChatIngressMonitor({
      accountId: account.accountId,
      queue,
      runtime,
      pollIntervalMs: 10,
      dispatch: async (event, turnAdoptionLifecycle) => {
        await processGoogleChatTestEvent({
          event,
          account,
          config: {},
          runtime,
          core,
          mediaMaxMb: 10,
          turnAdoptionLifecycle,
        });
      },
    });
    const first = createGoogleChatMediaTestEvent({
      id: "oversized",
      text: "first caption",
      attachments: [
        {
          contentType: "application/pdf",
          attachmentDataRef: { resourceName: "media/oversized" },
        },
      ],
    });
    const second = createGoogleChatMediaTestEvent({ id: "follow-up", text: "next message" });

    ingress.start();
    try {
      await ingress.receive(first);
      await ingress.waitForIdle();
      await ingress.receive(second);
      await ingress.waitForIdle();

      expect(receivedBodies).toEqual([
        "first caption\n\n[Google Chat attachment too large; maximum 10 MB]",
        "next message",
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      await ingress.stop();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes durable ingress adoption ownership into the inbound turn", async () => {
    const { core, runTurn } = createInboundClassificationHarness();
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => {}),
      abortSignal: new AbortController().signal,
    } satisfies GoogleChatIngressLifecycle;
    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event: {
        type: "MESSAGE",
        space: { name: "spaces/DURABLE", type: "DM" },
        message: {
          name: "spaces/DURABLE/messages/1",
          text: "hello",
          sender: { name: "users/alice", type: "HUMAN" },
        },
      },
      account: {
        accountId: "work",
        config: { typingIndicator: "none" },
        credentialSource: "inline",
      } as ResolvedGoogleChatAccount,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
      turnAdoptionLifecycle,
    });

    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ turnAdoptionLifecycle }));
  });

  it.each([
    { name: "the default off mode", replyToMode: undefined, expectedThread: undefined },
    { name: "explicit off mode", replyToMode: "off" as const, expectedThread: undefined },
    {
      name: "all mode",
      replyToMode: "all" as const,
      expectedThread: "spaces/CLASSIFY/threads/root",
    },
  ])("targets typing messages according to $name", async ({ replyToMode, expectedThread }) => {
    const { core } = createInboundClassificationHarness();
    const account = {
      accountId: "work",
      config: { replyToMode },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      space: { name: "spaces/CLASSIFY", spaceType: "SPACE" },
      message: {
        name: "spaces/CLASSIFY/messages/1",
        text: "hello",
        thread: { name: "spaces/CLASSIFY/threads/root" },
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "_OpenClaw is typing..._",
      thread: expectedThread,
    });
  });

  it("continues delivery in the typing message's canonical fallback thread", async () => {
    const requestedThread = "spaces/CLASSIFY/threads/requested";
    const deliveredThread = "spaces/CLASSIFY/threads/fallback";
    const runTurn = vi.fn(
      async (params: {
        adapter: {
          resolveTurn: () => {
            delivery: {
              deliver: (payload: { text: string; replyToId: string }) => Promise<void>;
            };
          };
        };
      }) => {
        const turn = params.adapter.resolveTurn();
        await turn.delivery.deliver({
          text: "two chunks",
          replyToId: requestedThread,
        });
      },
    );
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        inbound: {
          buildContext: vi.fn((payload: unknown) => payload),
          run: runTurn,
        },
        text: {
          resolveChunkMode: vi.fn(() => "markdown"),
          chunkMarkdownTextWithMode: vi.fn(() => ["first chunk", "second chunk"]),
        },
      },
    } as unknown as GoogleChatCoreRuntime;
    const account = {
      accountId: "work",
      config: { replyToMode: "all" },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      space: { name: "spaces/CLASSIFY", spaceType: "SPACE" },
      message: {
        name: "spaces/CLASSIFY/messages/1",
        text: "hello",
        thread: { name: requestedThread },
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/typing",
        threadName: deliveredThread,
      })
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/second",
        threadName: deliveredThread,
      });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/CLASSIFY",
      text: "_OpenClaw is typing..._",
      thread: requestedThread,
    });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "first chunk",
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/CLASSIFY",
      text: "second chunk",
      thread: deliveredThread,
    });
  });
});

describe("googlechat monitor sender bot status", () => {
  function botStatusEvent(senderType: "BOT" | "HUMAN", messageId: string): GoogleChatEvent {
    return {
      type: "MESSAGE",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: `spaces/DM/messages/${messageId}`,
        text: "hello",
        sender: { name: "users/sender", displayName: "Sender", type: senderType },
      },
    } satisfies GoogleChatEvent;
  }

  it("forwards bot sender status to the inbound context when allowBots is true", async () => {
    const { buildContext, core } = createInboundClassificationHarness();
    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event: botStatusEvent("BOT", "1"),
      account: {
        accountId: "work",
        config: { allowBots: true },
        credentialSource: "inline",
      } as ResolvedGoogleChatAccount,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ sender: expect.objectContaining({ isBot: true }) }),
    );
  });

  it("omits bot sender status for human senders", async () => {
    const { buildContext, core } = createInboundClassificationHarness();
    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event: botStatusEvent("HUMAN", "2"),
      account: {
        accountId: "work",
        config: {},
        credentialSource: "inline",
      } as ResolvedGoogleChatAccount,
      config: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      core,
      mediaMaxMb: 10,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ sender: expect.objectContaining({ isBot: undefined }) }),
    );
  });
});

describe("googlechat monitor direct messages", () => {
  it("creates typing messages by default", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            accountId: "work",
            sessionKey: "session-1",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {},
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
      text: "_OpenClaw is typing..._",
      thread: undefined,
    });
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("omits thread metadata from DM reply context and typing messages", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            accountId: "work",
            sessionKey: "session-1",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        thread: { name: "spaces/DM/threads/thread-1" },
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/DM/messages/typing",
    });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        reply: {
          to: "googlechat:spaces/DM",
          originatingTo: "googlechat:spaces/DM",
          replyToId: undefined,
          replyToIdFull: undefined,
        },
      }),
    );
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/DM",
      text: "_OpenClaw is typing..._",
      thread: undefined,
    });
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it("drops invalid event timestamps from inbound runtime payloads", async () => {
    const runTurn = vi.fn();
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-1",
            accountId: "work",
            sessionKey: "session-1",
          }),
        },
        session: {
          resolveStorePath: () => "/tmp/openclaw-googlechat-test",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: vi.fn(),
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        inbound: { buildContext, run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId: "work",
      config: {
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "not-a-timestamp",
      space: { name: "spaces/DM", type: "DM" },
      message: {
        name: "spaces/DM/messages/2",
        text: "hello",
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });

    await processGoogleChatTestEvent({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(inboundMocks.buildEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: undefined }),
    );
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({ timestamp: undefined }));
    const runArg = runTurn.mock.calls[0]?.[0] as
      | { adapter?: { ingest?: () => { timestamp?: number } } }
      | undefined;
    expect(runArg?.adapter?.ingest?.().timestamp).toBeUndefined();
  });
});
