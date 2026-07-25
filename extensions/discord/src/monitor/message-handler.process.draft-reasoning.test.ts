// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it } from "vitest";
import {
  createAutomaticSourceDeliveryContext,
  createNoQueuedDispatchResult,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runInPartialStreamMode,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createBlockModeContext,
  createMockDraftStreamForTest,
  firstDispatchParams,
  useProgressDraftStartDelay,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage draft streaming reasoning", () => {
  it("skips empty apply_patch starts and renders the patch summary", async () => {
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

    const ctx = await createAutomaticSourceDeliveryContext({
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

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🩹 1 modified; extensions/discord/src/monitor/message-handler.draft-preview.ts",
    );
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

    const ctx = await createAutomaticSourceDeliveryContext({
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

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Reading the event projector_",
    );
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

    const ctx = await createAutomaticSourceDeliveryContext({
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

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n🛠️ Exec\n• done");
    expect(draftStream.update.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      "Private planning",
    );
  });

  it("accumulates reasoning deltas in Discord progress drafts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      for (const text of ["Considering", " plugin", " installation", "!"]) {
        await params?.replyOptions?.onReasoningStream?.({ text });
      }
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Considering plugin installation!_",
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("• _!_");
  });

  it("preserves raw reasoning content that starts with Thinking", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking" });
      await params?.replyOptions?.onReasoningStream?.({ text: " through the install plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Thinking through the install plan_",
    );
  });

  it("preserves raw reasoning content that starts with Thinking colon", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking: compare install paths" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Thinking: compare install paths_",
    );
  });

  it("preserves raw reasoning content that starts with Reasoning colon", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reasoning: compare install paths" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Reasoning: compare install paths_",
    );
  });

  it("strips legacy Reasoning newline wrappers from progress snapshots", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Reasoning:\ncompare install paths",
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _compare install paths_",
    );
  });

  it("strips legacy Thinking ellipsis display wrappers from progress snapshots", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Thinking...\n\n_compare install paths_",
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _compare install paths_",
    );
  });

  it("preserves raw reasoning content that starts with a Thinking line", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking\nthrough the plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _Thinking through the plan_",
    );
  });

  it("appends raw reasoning chunks that start with Thinking", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "I was " });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking about the plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _I was Thinking about the plan_",
    );
  });

  it("appends raw reasoning chunks that start with Thinking ellipsis", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "I was " });
      await params?.replyOptions?.onReasoningStream?.({ text: "Thinking... through the plan" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _I was Thinking... through the plan_",
    );
  });

  it("appends raw reasoning chunks that start with Reasoning colon", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({ text: "I was " });
      await params?.replyOptions?.onReasoningStream?.({ text: "Reasoning: through edge cases" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith(
      "Clawing...\n\n🛠️ Exec\n🧠 _I was Reasoning: through edge cases_",
    );
  });

  it("keeps reasoning italics balanced when progress lines truncate", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Thinking through a very detailed installation plan with many steps",
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            maxLineChars: 36,
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    const lastUpdate = draftStream.update.mock.calls.at(-1)?.[0];
    const reasoningLine = lastUpdate?.split("\n").at(-1);

    expect(reasoningLine).toMatch(/^🧠 _.*…_$/u);
    expect(reasoningLine?.match(/_/gu)).toHaveLength(2);
  });

  it("replaces reasoning snapshots instead of appending duplicates", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Checking ",
        isReasoningSnapshot: true,
      });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Reading \n\nChecking ",
        isReasoningSnapshot: true,
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: "Clawing...",
            thinking: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update.mock.calls.at(-1)?.[0]).toContain("_Reading Checking_");
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("_Checking Reading");
  });

  it("keeps Discord progress lines across assistant boundaries", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "first", phase: "start" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      await params?.replyOptions?.onToolStart?.({ name: "second", phase: "start" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
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

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🧩 First\n🧩 Second");
    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  });

  it("suppresses standalone Discord tool progress when partial preview lines are disabled", async () => {
    createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    const ctx = await createAutomaticSourceDeliveryContext({
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

    const ctx = await createAutomaticSourceDeliveryContext({
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
