// Googlechat tests cover automatic reply target reconciliation at the monitor boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
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
    | ((event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  resolveChannelInboundRouteEnvelope: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  resolveChannelInboundRouteEnvelope: inboundMocks.resolveChannelInboundRouteEnvelope,
}));

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
      eventProcessor: (event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>,
    ) => {
      routingMocks.processEvent = eventProcessor;
    },
  ),
}));

type GoogleChatTestReplyPayload = { text: string; replyToId?: string };
type GoogleChatTestDelivery = {
  durable: (payload: GoogleChatTestReplyPayload, info: { kind: string }) => unknown;
  deliver: (payload: GoogleChatTestReplyPayload) => Promise<void>;
};

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
  inboundMocks.resolveChannelInboundRouteEnvelope.mockReset().mockReturnValue({
    route: {
      agentId: "agent-1",
      accountId: "work",
      sessionKey: "session-1",
    },
    buildEnvelope: ({ body }: { body: string }) => body,
  });
});

function createCore(params: {
  run: (delivery: GoogleChatTestDelivery) => Promise<void>;
  chunks?: string[];
}) {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: vi.fn((payload: unknown) => payload),
        run: vi.fn(
          async (turn: {
            adapter: { resolveTurn: () => { delivery: GoogleChatTestDelivery } };
          }) => {
            await params.run(turn.adapter.resolveTurn().delivery);
          },
        ),
      },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params.chunks ?? [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createEvent(params?: { messageName?: string; threadName?: string }): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/CLASSIFY", spaceType: "SPACE" },
    message: {
      name: params?.messageName ?? "spaces/CLASSIFY/messages/1",
      text: "hello",
      thread: { name: params?.threadName ?? "spaces/CLASSIFY/threads/requested" },
      sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
    },
  } satisfies GoogleChatEvent;
}

function createAccount(config: ResolvedGoogleChatAccount["config"]): ResolvedGoogleChatAccount {
  return {
    accountId: "work",
    config,
    credentialSource: "inline",
  } as ResolvedGoogleChatAccount;
}

async function processEvent(params: {
  account: ResolvedGoogleChatAccount;
  core: GoogleChatCoreRuntime;
  event?: GoogleChatEvent;
  runtime?: GoogleChatRuntimeEnv;
}) {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(params.event ?? createEvent(), {
    account: params.account,
    config: {},
    runtime: params.runtime ?? { error: vi.fn(), log: vi.fn() },
    core: params.core,
    mediaMaxMb: 10,
    path: "/googlechat",
  });
}

describe("Google Chat automatic reply target reconciliation", () => {
  it("keeps the typing thread when automatic delivery supplies the source message name", async () => {
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    const requestedThread = "spaces/CLASSIFY/threads/requested";
    const deliveredThread = "spaces/CLASSIFY/threads/fallback";
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      chunks: ["first chunk", "second chunk"],
      run: async (delivery) => {
        await delivery.deliver({ text: "two chunks", replyToId: sourceMessageName });
      },
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

    await processEvent({ account, core });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "first chunk",
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/CLASSIFY",
      text: "second chunk",
      thread: deliveredThread,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/CLASSIFY",
      text: "_OpenClaw is typing..._",
      thread: requestedThread,
    });
  });

  it("reconciles delivery and durable metadata without a typing message", async () => {
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    const replyThreadName = "spaces/CLASSIFY/threads/requested";
    let durableResult: unknown;
    const account = createAccount({ replyToMode: "all", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const payload = { text: "threaded reply", replyToId: sourceMessageName };
        durableResult = delivery.durable(payload, { kind: "final" });
        await delivery.deliver(payload);
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: "spaces/CLASSIFY/messages/reply",
      threadName: replyThreadName,
    });

    await processEvent({ account, core });

    expect(durableResult).toEqual({
      to: "spaces/CLASSIFY",
      replyToId: replyThreadName,
      threadId: replyThreadName,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "threaded reply",
      thread: replyThreadName,
    });
  });

  it("reconciles delivery after the typing message fails", async () => {
    const sourceMessageName = "spaces/CLASSIFY/messages/1";
    const replyThreadName = "spaces/CLASSIFY/threads/requested";
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      run: async (delivery) => {
        await delivery.deliver({ text: "threaded reply", replyToId: sourceMessageName });
      },
    });
    const runtime = { error: vi.fn(), log: vi.fn() };
    apiMocks.sendGoogleChatMessage
      .mockRejectedValueOnce(new Error("typing unavailable"))
      .mockResolvedValueOnce({
        messageName: "spaces/CLASSIFY/messages/reply",
        threadName: replyThreadName,
      });

    await processEvent({ account, core, runtime });

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed sending typing message: Error: typing unavailable",
    );
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/CLASSIFY",
      text: "threaded reply",
      thread: replyThreadName,
    });
  });

  it.each([
    ["different message", "spaces/CLASSIFY/messages/other"],
    ["whitespace-decorated message", " spaces/CLASSIFY/messages/1 "],
  ])("does not reinterpret a %s target", async (_name, targetMessageName) => {
    let durableResult: unknown;
    const account = createAccount({ replyToMode: "all", typingIndicator: "none" });
    const core = createCore({
      run: async (delivery) => {
        const payload = { text: "explicit reply", replyToId: targetMessageName };
        durableResult = delivery.durable(payload, { kind: "final" });
        await delivery.deliver(payload);
      },
    });

    await processEvent({ account, core });

    expect(durableResult).toEqual({
      to: "spaces/CLASSIFY",
      replyToId: targetMessageName.trim(),
      threadId: targetMessageName.trim(),
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/CLASSIFY",
      text: "explicit reply",
      thread: targetMessageName.trim(),
    });
  });
});
