// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it } from "vitest";
import {
  createNoQueuedDispatchResult,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runInPartialStreamMode,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createBlockModeContext,
  createMockDraftStreamForTest,
  firstDispatchParams,
  useProgressDraftStartDelay,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

type ReasoningProgressPayload = {
  text: string;
  isReasoningSnapshot?: boolean;
  requiresReasoningProgressOptIn?: boolean;
};

async function runReasoningProgressDraft(
  payloads: Array<string | ReasoningProgressPayload>,
  progress: {
    label?: string | false;
    maxLineChars?: number;
    thinking?: boolean;
  } = { label: "Clawing...", thinking: true },
) {
  const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
  const draftStream = createMockDraftStreamForTest();

  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
    for (const payload of payloads) {
      await params?.replyOptions?.onReasoningStream?.(
        typeof payload === "string" ? { text: payload } : payload,
      );
    }
    await elapseProgressDraftStartDelay();
    return createNoQueuedDispatchResult();
  });

  const ctx = await createAutomaticDraftContext({
    discordConfig: { streaming: { mode: "progress", progress } },
  });
  await runProcessDiscordMessage(ctx);
  return draftStream;
}

describe("processDiscordMessage draft streaming reasoning", () => {
  it("starts a quiet summary for a completed patch without exposing patch details", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "apply_patch", phase: "start" });
      await params?.replyOptions?.onPatchSummary?.({
        phase: "end",
        name: "apply_patch",
        summary: "1 modified",
        modified: ["extensions/discord/src/monitor/message-handler.draft-preview.ts"],
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...");
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Apply Patch");
  });

  it("shows reasoning text instead of a bare Reasoning progress line", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({
        kind: "analysis",
        title: "Reasoning",
      });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reading the event projector" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\nReading the event projector");
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Reasoning");
    expect(updates.join("\n")).not.toContain("Thinking\n");
  });

  it("hides non-stream reasoning progress until Discord thinking progress is enabled", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Private planning",
        requiresReasoningProgressOptIn: true,
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...");
    expect(draftStream.update.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      "Private planning",
    );
  });

  it("accumulates reasoning deltas in Discord progress drafts", async () => {
    const draftStream = await runReasoningProgressDraft([
      "Considering",
      " plugin",
      " installation",
      "!",
    ]);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\nConsidering plugin installation!",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("• _!_");
  });

  it("preserves raw reasoning content that starts with Thinking", async () => {
    const draftStream = await runReasoningProgressDraft(["Thinking", " through the install plan"]);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\nThinking through the install plan",
    );
  });

  it("preserves raw reasoning content that starts with Thinking colon", async () => {
    const draftStream = await runReasoningProgressDraft(["Thinking: compare install paths"]);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\nThinking: compare install paths",
    );
  });

  it("preserves raw reasoning content that starts with Reasoning colon", async () => {
    const draftStream = await runReasoningProgressDraft(["Reasoning: compare install paths"]);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\nReasoning: compare install paths",
    );
  });

  it("strips legacy Reasoning newline wrappers from progress snapshots", async () => {
    const draftStream = await runReasoningProgressDraft(["Reasoning:\ncompare install paths"]);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\ncompare install paths");
  });

  it("strips legacy Thinking ellipsis display wrappers from progress snapshots", async () => {
    const draftStream = await runReasoningProgressDraft(["Thinking...\n\n_compare install paths_"]);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\ncompare install paths");
  });

  it("preserves raw reasoning content that starts with a Thinking line", async () => {
    const draftStream = await runReasoningProgressDraft(["Thinking\nthrough the plan"]);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\nThinking through the plan");
  });

  it("appends raw reasoning chunks that start with Thinking", async () => {
    const draftStream = await runReasoningProgressDraft(["I was ", "Thinking about the plan"]);

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\nI was Thinking about the plan");
  });

  it("appends raw reasoning chunks that start with Thinking ellipsis", async () => {
    const draftStream = await runReasoningProgressDraft(["I was ", "Thinking... through the plan"]);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\nI was Thinking... through the plan",
    );
  });

  it("appends raw reasoning chunks that start with Reasoning colon", async () => {
    const draftStream = await runReasoningProgressDraft([
      "I was ",
      "Reasoning: through edge cases",
    ]);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\nI was Reasoning: through edge cases",
    );
  });

  it("truncates plain reasoning at a word boundary without generated decoration", async () => {
    const draftStream = await runReasoningProgressDraft(
      ["Thinking through a very detailed installation plan with many steps"],
      { label: "Clawing...", maxLineChars: 36, thinking: true },
    );

    const lastUpdate = draftStream.update.mock.calls.at(-1)?.[0];
    const reasoningLine = lastUpdate?.split("\n").at(-1);

    expect(reasoningLine).toBe("Thinking through a very…");
  });

  it("replaces reasoning snapshots instead of appending duplicates", async () => {
    const draftStream = await runReasoningProgressDraft([
      {
        text: "Checking ",
        isReasoningSnapshot: true,
      },
      {
        text: "Reading \n\nChecking ",
        isReasoningSnapshot: true,
      },
    ]);

    expect(draftStream.update.mock.calls.at(-1)?.[0]).toContain("Reading Checking");
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("Checking Reading");
  });

  it("keeps one quiet Discord summary across assistant boundaries", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Shelling",
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Shelling");
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("suppresses standalone Discord tool progress when partial preview lines are disabled", async () => {
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "partial",
          preview: {
            toolProgress: false,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(firstDispatchParams().replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
  });

  it("strips reply tags from preview partials", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "[[reply_to_current]] Hello world",
      });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("Hello world");
  });

  it("forces new preview messages on assistant boundaries in block mode", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext();

    await runProcessDiscordMessage(ctx);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("strips reasoning tags from partial stream updates", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "<thinking>Let me think about this</thinking>\nThe answer is 42",
      });
      return createNoQueuedDispatchResult();
    });

    await runInPartialStreamMode();

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    for (const text of updates) {
      expect(text).not.toContain("<thinking>");
    }
  });

  it("skips pure-reasoning partial updates without updating draft", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "Reasoning:\nThe user asked about X so I need to consider Y",
      });
      return createNoQueuedDispatchResult();
    });

    await runInPartialStreamMode();

    expect(draftStream.update).not.toHaveBeenCalled();
  });
});
