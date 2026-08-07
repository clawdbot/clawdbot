import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../types.js";
import { startGateway, type CoreGatewayContext } from "./gateway.js";
import type { InboundPipelineDeps } from "./inbound-context.js";
import type { QueuedMessage } from "./message-queue.js";
import type { GatewayAccount } from "./types.js";

const mocks = vi.hoisted(() => ({
  clearTokenCache: vi.fn(),
  handleMessage: undefined as ((event: QueuedMessage) => Promise<void>) | undefined,
  sendInputNotify: vi.fn(),
}));

vi.mock("../commands/slash-commands-impl.js", () => ({
  initCommands: vi.fn(),
}));

vi.mock("../messaging/outbound-reply.js", () => ({
  claimMessageReply: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../messaging/outbound.js", () => ({
  setOutboundAudioPort: vi.fn(),
}));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: vi.fn((account: GatewayAccount) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  })),
  buildDeliveryTarget: vi.fn(),
  clearTokenCache: mocks.clearTokenCache,
  createRawInputNotifyFn: vi.fn(() => vi.fn()),
  getAccessToken: vi.fn(async () => "token"),
  initApiConfig: vi.fn(),
  onMessageSent: vi.fn(),
  sendInputNotify: mocks.sendInputNotify,
  sendText: vi.fn(),
}));

vi.mock("../utils/diagnostics.js", () => ({
  runDiagnostics: vi.fn(async () => ({ warnings: [] })),
}));

vi.mock("./gateway-connection.js", () => ({
  GatewayConnection: class {
    constructor(options: { handleMessage: (event: QueuedMessage) => Promise<void> }) {
      mocks.handleMessage = options.handleMessage;
    }

    async start() {}
  },
}));

vi.mock("./inbound-pipeline.js", () => ({
  buildInboundContext: vi.fn(
    async (event: QueuedMessage, deps: Pick<InboundPipelineDeps, "startTyping">) => ({
      blocked: true,
      blockReason: "test",
      typing: await deps.startTyping(event),
    }),
  ),
  clearGroupPendingHistory: vi.fn(),
}));

vi.mock("./interaction-handler.js", () => ({
  createInteractionHandler: vi.fn(() => vi.fn()),
}));

vi.mock("./outbound-dispatch.js", () => ({
  dispatchOutbound: vi.fn(),
}));

function makeContext(accountId = "default", withCredentials = true): CoreGatewayContext {
  return {
    account: {
      accountId,
      appId: withCredentials ? "app-id" : "",
      clientSecret: withCredentials ? "secret" : "",
      markdownSupport: false,
      config: {},
    },
    cfg: {},
    getCurrentConfig: () => ({}),
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      channel: {
        activity: { record: vi.fn() },
      },
    },
    adapters: {
      commands: {},
      outboundAudio: {},
    },
  } as unknown as CoreGatewayContext;
}

describe("QQBot gateway configuration guidance", () => {
  it("shows default-account recovery paths from the real gateway entry point", async () => {
    await expect(startGateway(makeContext("default", false))).rejects.toThrow(
      /channels\.qqbot\.appId.*QQBOT_APP_ID and QQBOT_CLIENT_SECRET/,
    );
  });

  it("shows account-scoped recovery without default-only env vars", async () => {
    let error: unknown;
    try {
      await startGateway(makeContext("operations", false));
    } catch (caught) {
      error = caught;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("channels.qqbot.accounts.operations.appId");
    expect(message).not.toContain("QQBOT_APP_ID");
    expect(message).not.toContain("QQBOT_CLIENT_SECRET");
  });
});

async function sendC2CTyping(): Promise<void> {
  await startGateway(makeContext());
  const handleMessage = mocks.handleMessage;
  if (!handleMessage) {
    throw new Error("Gateway did not register a message handler");
  }
  await handleMessage({
    type: "c2c",
    senderId: "openid-1",
    content: "hello",
    messageId: "msg-1",
    timestamp: "2026-08-07T00:00:00Z",
  });
}

describe("QQBot gateway typing token retry", () => {
  beforeEach(() => {
    mocks.clearTokenCache.mockReset();
    mocks.handleMessage = undefined;
    mocks.sendInputNotify.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes a keyword-free HTTP 500/business-code 11244 failure", async () => {
    mocks.sendInputNotify
      .mockRejectedValueOnce(new ApiError("credential rejected", 500, "/typing", 11244))
      .mockResolvedValueOnce({ refIdx: "ref-1" });

    await sendC2CTyping();

    expect(mocks.clearTokenCache).toHaveBeenCalledOnce();
    expect(mocks.clearTokenCache).toHaveBeenCalledWith("app-id");
    expect(mocks.sendInputNotify).toHaveBeenCalledTimes(2);
  });

  it("preserves the string fallback for non-ApiError failures", async () => {
    mocks.sendInputNotify
      .mockRejectedValueOnce(new Error("401 token rejected"))
      .mockResolvedValueOnce({ refIdx: "ref-1" });

    await sendC2CTyping();

    expect(mocks.clearTokenCache).toHaveBeenCalledOnce();
    expect(mocks.sendInputNotify).toHaveBeenCalledTimes(2);
  });
});
