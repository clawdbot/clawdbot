// Regression at the real Google Chat admission boundary after a media retry.
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
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

type RoutingHarness = {
  processEvent?: (
    event: GoogleChatEvent,
    target: Record<string, unknown>,
    turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
  ) => Promise<void>;
};
const routingMocks = vi.hoisted((): RoutingHarness => ({}));

const inboundMocks = vi.hoisted(() => ({
  buildEnvelope: vi.fn(({ body }: { body: string }) => body),
  resolveChannelInboundRouteEnvelope: vi.fn(),
  toInboundMediaFactsWithMetadata: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  inboundMocks.toInboundMediaFactsWithMetadata.mockImplementation(
    actual.toInboundMediaFactsWithMetadata,
  );
  return {
    ...actual,
    resolveChannelInboundRouteEnvelope: inboundMocks.resolveChannelInboundRouteEnvelope,
    toInboundMediaFactsWithMetadata: inboundMocks.toInboundMediaFactsWithMetadata,
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
  inboundMocks.toInboundMediaFactsWithMetadata.mockClear();
});

function createInboundClassificationHarness() {
  const buildContext = vi.fn((payload: unknown) => payload);
  const runTurn = vi.fn();
  const saveMediaBuffer = vi.fn(async () => ({
    path: "/tmp/googlechat-first.png",
    contentType: "image/png",
  }));
  // SAFETY: this isolated ingress test supplies the logging, inbound, and media
  // services used on this path; unrelated host runtime services are never called.
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext, run: runTurn },
      media: { saveMediaBuffer },
    },
  } as unknown as GoogleChatCoreRuntime;
  return { buildContext, core, runTurn, saveMediaBuffer };
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

describe("googlechat monitor conversation burst retries", () => {
  it("does not charge a pre-adoption retry twice against the shared conversation budget", async () => {
    const { core, runTurn } = createInboundClassificationHarness();
    const runtime = { error: vi.fn(), log: vi.fn() };
    const account: ResolvedGoogleChatAccount = {
      accountId: "conversation-burst-retry",
      enabled: true,
      config: { allowBots: true, botUser: "users/app", typingIndicator: "none" },
      credentialSource: "inline",
    };
    const config = {
      channels: {
        defaults: {
          botLoopProtection: {
            maxEventsPerWindow: 100,
            maxConversationBotEvents: 4,
            windowSeconds: 60,
            cooldownSeconds: 60,
          },
        },
      },
    };
    allowGoogleChatMediaSender();
    const event = (id: string, sender: string) =>
      ({
        type: "MESSAGE",
        eventTime: "2026-03-23T00:00:00.000Z",
        space: { name: "spaces/BURST-RETRY", type: "SPACE" },
        message: {
          name: `spaces/BURST-RETRY/messages/${id}`,
          text: id,
          sender: { name: sender, type: "BOT" },
        },
      }) satisfies GoogleChatEvent;
    const process = (incomingEvent: GoogleChatEvent) =>
      processGoogleChatTestEvent({
        event: incomingEvent,
        account,
        config,
        runtime,
        core,
        mediaMaxMb: 10,
      });
    await process(event("a1", "users/bot-a"));
    await process(event("a2", "users/bot-a"));
    const original = event("b1", "users/bot-b");
    const retry: GoogleChatEvent = {
      ...original,
      message: {
        ...original.message,
        attachment: [
          { contentType: "image/png", attachmentDataRef: { resourceName: "media/burst-retry" } },
        ],
      },
    };
    apiMocks.downloadGoogleChatMedia
      .mockRejectedValueOnce(new MediaFetchError("fetch_failed", "transient download failure"))
      .mockResolvedValue({ buffer: Buffer.from("image"), contentType: "image/png" });
    await expect(process(retry)).rejects.toThrow("transient download failure");
    expect(runTurn).toHaveBeenCalledTimes(2);
    // Durable ingress retries this unadopted message, not a new logical bot event.
    await process(retry);
    await process(event("b2", "users/bot-b"));
    expect(runTurn).toHaveBeenCalledTimes(4);
    // A genuinely new fifth event must still trip the conversation budget.
    await process(event("b3", "users/bot-b"));
    expect(runTurn).toHaveBeenCalledTimes(4);
  });
});
