import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { DispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const settlePendingFinalDelivery = vi.hoisted(() =>
  vi.fn(async (_completion: unknown, state: string) => ({ state })),
);

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(async () => []),
}));

vi.mock("../../infra/outbound/delivery-completion.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-completion.js")>();
  return { ...actual, settlePendingFinalDelivery };
});

const cfg: OpenClawConfig = {};

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    CommandAuthorized: false,
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  };
}

describe("channel turn failed-send custody", () => {
  const completion = {
    deliveryId: "delivery-failed",
    intentId: "intent-failed",
    sessionId: "session-failed",
    sessionKey: "agent:main:telegram:peer",
    storePath: "/tmp/sessions.json",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getGlobalHookRunner.mockReturnValue(null);
    settlePendingFinalDelivery.mockImplementation(async (_completion, state: string) => ({
      state,
    }));
  });

  const run = (error: Error) => {
    const sourcePayload = setReplyPayloadMetadata(
      { text: "reply" },
      { pendingFinalDeliveryCompletion: completion },
    );
    const dispatch: DispatchReplyWithDispatcher = async (params) => {
      await params.dispatcherOptions.deliver(sourcePayload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    };
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(dispatch);
    return dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "acct",
      route: { agentId: "main", sessionKey: completion.sessionKey },
      ctxPayload: createCtx({ Surface: "telegram", OriginatingTo: "chat-1" }),
      delivery: {
        deliver: async (_payload: ReplyPayload) => {
          throw error;
        },
      },
    });
  };

  it.each([
    {
      label: "permanent typed rejection settles suppressed",
      error: new PlatformMessageNotDispatchedError("media-only payload rejected", {
        cause: undefined,
        retryable: false,
      }),
      failureSettle: ["suppressed", ["prepared", "queued", "unknown"]] as const,
    },
    {
      label: "untyped failure affirms unknown custody",
      error: new Error("adapter failed after entry"),
      failureSettle: ["unknown", ["queued", "unknown"]] as const,
    },
  ])("$label", async ({ error, failureSettle }) => {
    await expect(run(error)).rejects.toBe(error);

    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      1,
      { kind: "pending-final", ...completion },
      "unknown",
      ["prepared", "queued"],
    );
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      2,
      { kind: "pending-final", ...completion },
      failureSettle[0],
      failureSettle[1],
    );
  });

  it("restores prepared custody after a retryable typed rejection", async () => {
    const preflight = new PlatformMessageNotDispatchedError("preflight failed", {
      cause: new Error("local preflight"),
    });

    await expect(run(preflight)).rejects.toBe(preflight);

    // The pre-I/O claim wrote unknown; the proven no-send must roll it back to
    // prepared so recovery replays instead of recording false ambiguity.
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      1,
      { kind: "pending-final", ...completion },
      "unknown",
      ["prepared", "queued"],
    );
    expect(settlePendingFinalDelivery).toHaveBeenNthCalledWith(
      2,
      { kind: "pending-final", ...completion },
      "prepared",
      ["queued", "unknown"],
    );
  });
});
