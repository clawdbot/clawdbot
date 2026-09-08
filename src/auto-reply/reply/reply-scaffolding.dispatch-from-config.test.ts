import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  emptyConfig,
  hookMocks,
  mocks,
  resetPluginTtsAndThreadMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;

describe("dispatch-owned reply scaffolding provenance", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    setDiscordTestRegistry();
    hookMocks.runner.hasHooks.mockReset().mockReturnValue(false);
    mocks.tryFastAbortFromMessage.mockReset().mockResolvedValue({
      handled: false,
      aborted: false,
    });
  });

  it("sanitizes reasoning snapshots without changing source payloads or presentation metadata", async () => {
    const internal =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate metadata\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const source: Array<Parameters<NonNullable<GetReplyOptions["onReasoningStream"]>>[0]> = [
      { text: internal },
      {
        text: `${internal}\n\nChecking files.`,
        isReasoning: true,
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
      { text: `${internal}\n\nReading config.\n\nChecking files.`, isReasoningSnapshot: true },
      { text: internal, mediaUrls: ["https://example.com/reasoning.png"] },
    ];
    const original = structuredClone(source);
    const observed: typeof source = [];
    const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "Show status.",
        BodyForAgent: "Show status.",
        From: "user1",
        Surface: "telegram",
        SessionKey: "agent:test:reasoning-scaffolding",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: {
        onReasoningStream: (payload) => {
          observed.push(payload);
          return false;
        },
      },
      replyResolver: async (_ctx, options) => {
        for (const payload of source) {
          await options?.onReasoningStream?.(payload);
        }
        return { text: "Visible answer." };
      },
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(source).toEqual(original);
    expect(observed).toEqual([
      {
        text: "Checking files.",
        isReasoning: true,
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
      { text: "Reading config.\n\nChecking files.", isReasoningSnapshot: true },
      { text: "", mediaUrls: ["https://example.com/reasoning.png"] },
    ]);
  });

  it("binds the finalized inbound prompt before raw final replies reach the dispatcher", async () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "[Telegram] Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const delivered: ReplyPayload[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: conversationContext,
        BodyForAgent: conversationContext,
        From: "user1",
        Surface: "telegram",
        SessionKey: "agent:test:scaffolding-provenance",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: `${conversationContext}\n\nVisible answer.` }),
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(result.queuedFinal).toBe(true);
    expect(delivered).toEqual([expect.objectContaining({ text: "Visible answer." })]);
  });
});
