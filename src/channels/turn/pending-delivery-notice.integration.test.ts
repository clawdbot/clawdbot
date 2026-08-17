import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const recordInboundSessionCore = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});
vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: recordInboundSessionCore };
});
vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript,
    readRecentUserAssistantTextForSession: vi.fn(async () => []),
  };
});

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    CommandAuthorized: false,
    From: "sender",
    To: "chat-1",
    SessionKey: "agent:main:telegram:direct:chat-1",
    Provider: "telegram",
    Surface: "telegram",
    ...overrides,
  };
}

// Injected ambiguous final-send trace: turn 1 fails after the pre-I/O claim and
// must persist owed notice debt; turn 2 on the same route must deliver exactly
// one uncertainty notice and acknowledge the debt. Store, settlement, and turn
// lifecycle are real; only transport ends are stubbed.
describe("pending delivery notice end to end", () => {
  let tmpDir: string;
  let storePath: string;
  let cfg: OpenClawConfig;
  const sessionKey = "agent:main:telegram:direct:chat-1";
  const context = { channel: "telegram", to: "chat-1", accountId: "default" };
  const completion = {
    deliveryId: "delivery-e2e",
    intentId: "intent-e2e",
    sessionId: "session-e2e",
    sessionKey,
    storePath: "",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockResolvedValue({ suppressed: false });
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-notice-e2e-"));
    storePath = path.join(tmpDir, "sessions.json");
    completion.storePath = storePath;
    cfg = { session: { store: storePath } } as OpenClawConfig;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId: completion.sessionId,
        status: "done",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: { channel: "telegram", accountId: "default" },
          context,
          origin: {},
        },
        pendingFinalDelivery: {
          kind: "replayable",
          text: "the final answer",
          createdAt: Date.now(),
          context,
          intentId: completion.intentId,
          deliveries: [{ id: completion.deliveryId, state: "prepared" }],
        },
      },
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const runTurn = (
    deliver: () => Promise<{ visibleReplySent: boolean }>,
    options?: { bindCustody?: boolean },
  ) => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      const payload =
        options?.bindCustody === false
          ? { text: "the final answer" }
          : setReplyPayloadMetadata(
              { text: "the final answer" },
              { pendingFinalDeliveryCompletion: completion },
            );
      await params.dispatcherOptions.deliver(payload, { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    return dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "default",
      route: { agentId: "main", sessionKey },
      ctxPayload: createCtx({ OriginatingTo: "chat-1" }),
      delivery: { deliver },
    });
  };

  it("turns an injected ambiguous loss into one same-route notice", async () => {
    const ambiguous = new Error("socket closed before response");
    await expect(
      runTurn(async () => {
        throw ambiguous;
      }),
    ).rejects.toBe(ambiguous);

    const afterLoss = loadSessionEntry({ sessionKey, storePath });
    expect(afterLoss?.pendingFinalDelivery?.deliveries).toEqual([
      { id: completion.deliveryId, state: "unknown" },
    ]);
    expect(afterLoss?.pendingDeliveryNotice).toMatchObject({
      intentId: completion.intentId,
      state: "owed",
    });
    expect(sendRecoveryNotice).not.toHaveBeenCalled();

    // The next turn carries its own fresh custody; the stale intent stays put.
    await runTurn(async () => ({ visibleReplySent: true }), { bindCustody: false });

    expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "telegram",
        to: "chat-1",
        text: expect.stringContaining("couldn’t confirm"),
      }),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.pendingDeliveryNotice).toBeUndefined();
  });
});
