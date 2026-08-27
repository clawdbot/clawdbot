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
  createChannelInboundEnvelopeBuilder: vi.fn(),
  resolveChannelInboundRouteEnvelope: vi.fn(),
  toInboundMediaFactsWithMetadata: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundEnvelopeBuilder: inboundMocks.createChannelInboundEnvelopeBuilder,
    resolveChannelInboundRouteEnvelope: inboundMocks.resolveChannelInboundRouteEnvelope,
    toInboundMediaFactsWithMetadata: inboundMocks.toInboundMediaFactsWithMetadata,
  };
});

vi.mock("./api.js", () => apiMocks);
vi.mock("./monitor-access.js", () => accessMocks);
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(
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
  setGoogleChatWebhookEventProcessor: vi.fn(
    (
      callback: (
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>,
    ) => {
      routingMocks.processEvent = callback;
    },
  ),
}));

beforeEach(() => {
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
  inboundMocks.buildEnvelope.mockReset().mockImplementation(({ body }: { body: string }) => body);
  inboundMocks.createChannelInboundEnvelopeBuilder
    .mockReset()
    .mockReturnValue(inboundMocks.buildEnvelope);
  inboundMocks.resolveChannelInboundRouteEnvelope
    .mockReset()
    .mockImplementation(({ accountId }: { accountId: string }) => ({
      route: { agentId: "agent-1", accountId, sessionKey: "session-1" },
      buildEnvelope: inboundMocks.buildEnvelope,
    }));
});

async function processTestEvent(
  event: GoogleChatEvent,
  core: GoogleChatCoreRuntime,
): Promise<void> {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(event, {
    account: {
      accountId: "work",
      config: { typingIndicator: "none" },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount,
    config: {},
    runtime: { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv,
    core,
    mediaMaxMb: 10,
    path: "/googlechat",
  });
}

describe("googlechat monitor thread sessions", () => {
  it("isolates distinct threads while keeping an unthreaded space message in its base session", async () => {
    const buildContext = vi.fn((payload: unknown) => payload);
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: { inbound: { buildContext, run: vi.fn() }, media: { saveMediaBuffer: vi.fn() } },
    } as unknown as GoogleChatCoreRuntime;

    for (const [messageId, threadName] of [
      ["first", "spaces/CLASSIFY/threads/first"],
      ["second", "spaces/CLASSIFY/threads/second"],
      ["root", undefined],
    ]) {
      await processTestEvent(
        {
          type: "MESSAGE",
          space: { name: "spaces/CLASSIFY", spaceType: "SPACE" },
          message: {
            name: `spaces/CLASSIFY/messages/${messageId}`,
            text: "hello",
            ...(threadName ? { thread: { name: threadName } } : {}),
            sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
          },
        } satisfies GoogleChatEvent,
        core,
      );
    }

    expect(
      buildContext.mock.calls.map(
        ([payload]) => (payload as { route: { routeSessionKey: string } }).route.routeSessionKey,
      ),
    ).toEqual([
      "session-1:thread:spaces/classify/threads/first",
      "session-1:thread:spaces/classify/threads/second",
      "session-1",
    ]);
  });
});
