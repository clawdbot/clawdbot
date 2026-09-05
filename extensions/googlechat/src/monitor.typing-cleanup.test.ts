// Googlechat tests cover typing placeholder custody when no reply is delivered.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatIngressLifecycle } from "./monitor-ingress.js";
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
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
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

const account = {
  accountId: "work",
  config: {},
  credentialSource: "inline",
} as ResolvedGoogleChatAccount;

function createTypingCleanupHarness(runTurn: ReturnType<typeof vi.fn>) {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext: vi.fn((payload: unknown) => payload), run: runTurn },
      media: { saveMediaBuffer: vi.fn() },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function typingCleanupEvent(spaceName: string): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: spaceName, spaceType: "SPACE" },
    message: {
      name: `${spaceName}/messages/1`,
      text: "hello",
      sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
    },
  } satisfies GoogleChatEvent;
}

async function processTypingCleanupEvent(params: {
  event: GoogleChatEvent;
  core: GoogleChatCoreRuntime;
  runtime: GoogleChatRuntimeEnv;
}): Promise<void> {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(params.event, {
    account,
    config: {},
    runtime: params.runtime,
    core: params.core,
    mediaMaxMb: 10,
    path: "/googlechat",
  });
}

describe("googlechat monitor typing placeholder custody", () => {
  it("deletes the unclaimed placeholder when the turn resolves without delivering a reply", async () => {
    const core = createTypingCleanupHarness(vi.fn().mockResolvedValue(undefined));
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/SILENT/messages/typing",
      threadName: undefined,
    });

    await processTypingCleanupEvent({
      event: typingCleanupEvent("spaces/SILENT"),
      core,
      runtime: { error: vi.fn(), log: vi.fn() },
    });

    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/SILENT/messages/typing",
    });
  });

  it("deletes the unclaimed placeholder when the turn throws before delivering a reply", async () => {
    const turnError = new Error("turn boom");
    const core = createTypingCleanupHarness(vi.fn().mockRejectedValue(turnError));
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/THROW/messages/typing",
      threadName: undefined,
    });

    await expect(
      processTypingCleanupEvent({
        event: typingCleanupEvent("spaces/THROW"),
        core,
        runtime: { error: vi.fn(), log: vi.fn() },
      }),
    ).rejects.toThrow(turnError);

    expect(apiMocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/THROW/messages/typing",
    });
  });

  it("keeps the original turn failure when placeholder cleanup also fails", async () => {
    const turnError = new Error("turn boom");
    const core = createTypingCleanupHarness(vi.fn().mockRejectedValue(turnError));
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLEANUPFAIL/messages/typing",
      threadName: undefined,
    });
    apiMocks.deleteGoogleChatMessage.mockRejectedValue(new Error("delete boom"));

    await expect(
      processTypingCleanupEvent({
        event: typingCleanupEvent("spaces/CLEANUPFAIL"),
        core,
        runtime,
      }),
    ).rejects.toThrow(turnError);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Google Chat typing cleanup failed"),
    );
  });

  it("leaves placeholder deletion to delivery once a reply claims it", async () => {
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        inbound: {
          buildContext: vi.fn((payload: unknown) => payload),
          run: vi.fn(
            async (params: {
              adapter: {
                resolveTurn: () => {
                  delivery: { deliver: (payload: { text: string }) => Promise<void> };
                };
              };
            }) => {
              await params.adapter.resolveTurn().delivery.deliver({ text: "answer" });
            },
          ),
        },
        media: { saveMediaBuffer: vi.fn() },
        text: {
          resolveChunkMode: vi.fn(() => "markdown"),
          chunkMarkdownTextWithMode: vi.fn(() => ["answer"]),
        },
      },
    } as unknown as GoogleChatCoreRuntime;
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLAIMED/messages/typing",
      threadName: undefined,
    });

    await processTypingCleanupEvent({
      event: typingCleanupEvent("spaces/CLAIMED"),
      core,
      runtime: { error: vi.fn(), log: vi.fn() },
    });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLAIMED/messages/typing",
      text: "answer",
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
  });
});
