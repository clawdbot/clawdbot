// Progress draft compositor tests cover streamed draft composition for channel progress updates.
import { describe, expect, it, vi } from "vitest";
import {
  createChannelProgressDraftCompositor,
  createChannelProgressWorkCounter,
} from "./progress-draft-compositor.js";

function createTestProgressDraftCompositor(
  overrides: Omit<
    Parameters<typeof createChannelProgressDraftCompositor>[0],
    "mode" | "active" | "seed"
  >,
) {
  return createChannelProgressDraftCompositor({
    mode: "progress",
    active: true,
    seed: "test",
    ...overrides,
  });
}

const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;

describe("createChannelProgressDraftCompositor", () => {
  it("keeps summary presentation stable across tool activity and uses plain milestones", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress" } },
      presentation: "summary",
      update,
    });
    await progress.pushPreambleHeadline("Checking source 🔎");
    await progress.noteActivity({ startImmediately: true });
    for (let index = 0; index < 20; index++) {
      await progress.pushToolEvent({ name: "exec", toolCallId: `call-${index}`, phase: "start" });
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe("Checking source 🔎");
    await progress.pushPlanProgress([{ step: "Verify behavior", status: "in_progress" }]);
    expect(update.mock.lastCall?.[0]).toBe("Checking source 🔎\n\nIn progress: Verify behavior");
    progress.cancel();
  });

  it("shows and resolves summary approval attention independently of tool activity", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress" } },
      presentation: "summary",
      update,
    });
    await progress.pushApprovalEvent({
      phase: "requested",
      approvalId: "approval-1",
      title: "Run checks",
    });
    expect(update.mock.lastCall?.[0]).toContain("Run checks");
    expect(update.mock.lastCall?.[1]).toMatchObject({ flush: true });
    await progress.pushPlanProgress(
      Array.from({ length: 8 }, (_, index) => ({
        step: `Milestone ${index + 1}`,
        status: "pending" as const,
      })),
    );
    expect(update.mock.lastCall?.[0]).toContain("Run checks");
    await progress.pushPlanProgress([]);
    for (let index = 0; index < 20; index++) {
      await progress.pushToolEvent({ name: "read", toolCallId: `call-${index}`, phase: "start" });
    }
    expect(update.mock.lastCall?.[0]).toContain("Run checks");
    await progress.pushApprovalEvent({ phase: "resolved", approvalId: "approval-1" });
    expect(update.mock.lastCall?.[0]).toBe("Working");
    progress.cancel();
  });

  it("counts only work tool calls and resets per turn", () => {
    let now = 1_000;
    const work = createChannelProgressWorkCounter({ now: () => now });

    work.noteToolCall("exec");
    work.noteToolCall("progress_card");
    now = 43_000;

    expect(work.toolCalls).toBe(1);
    expect(work.elapsedSeconds).toBe(42);

    work.reset();
    now = 43_500;
    expect(work.toolCalls).toBe(0);
    expect(work.elapsedSeconds).toBe(1);
  });

  it("starts immediately for plans, replaces snapshots, and clears them on reset", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update,
    });

    await progress.pushPreambleHeadline("Implementing the change.");
    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ]);

    expect(progress.hasStarted).toBe(true);
    expect(update).toHaveBeenLastCalledWith(
      "Implementing the change.\n\n✅ Inspect\n▸ Patch",
      expect.objectContaining({ flush: true }),
    );

    await progress.pushPlanProgress([{ step: "Test", status: "in_progress" }]);
    expect(update).toHaveBeenLastCalledWith(
      "Implementing the change.\n\n▸ Test",
      expect.anything(),
    );

    progress.reset();
    await progress.pushToolProgress("🛠️ Next", { startImmediately: true });
    expect(update).toHaveBeenLastCalledWith("🛠️ Next", expect.anything());
  });

  it("keeps plan task progress independent from tool progress", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: false, commentary: true, toolProgress: false },
        },
      },
      update,
    });

    expect(
      await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
        explanation: "Applying the change.",
      }),
    ).toBe(true);
    expect(update).toHaveBeenLastCalledWith("Applying the change.\n\n▸ Patch", {
      flush: true,
      lines: [],
      planLayout: { activeLineIndex: 0, lineCount: 1 },
    });
  });

  it("optionally scopes rolling lines to the active plan step", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update: vi.fn(),
      resetRollingLinesOnPlanStepChange: true,
    });

    await progress.pushToolProgress("🛠️ Early command", { startImmediately: true });
    await progress.pushPlanProgress([
      { step: "Prepare", status: "completed" },
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
    ]);
    expect(progress.getSnapshot().lines).toEqual(["🛠️ Early command"]);

    await progress.pushPlanProgress(
      [
        { step: "Prepare", status: "completed" },
        { step: "Inspect", status: "in_progress" },
        { step: "Patch", status: "pending" },
      ],
      { explanation: "Still inspecting." },
    );
    expect(progress.getSnapshot().lines).toEqual(["🛠️ Early command"]);

    await progress.pushPlanProgress([
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
    ]);
    expect(progress.getSnapshot().lines).toEqual(["🛠️ Early command"]);

    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ]);
    expect(progress.getSnapshot().lines).toEqual([]);

    await progress.pushToolProgress("🛠️ Patch command", { startImmediately: true });
    expect(progress.getSnapshot().lines).toEqual(["🛠️ Patch command"]);

    await progress.pushPlanProgress([
      { step: "Run tests", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ]);
    await progress.pushToolProgress("🛠️ First test run", { startImmediately: true });
    await progress.pushPlanProgress([
      { step: "Run tests", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ]);
    expect(progress.getSnapshot().lines).toEqual(["🛠️ First test run"]);

    await progress.pushPlanProgress([
      { step: "Run tests", status: "completed" },
      { step: "Run tests", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ]);
    expect(progress.getSnapshot().lines).toEqual([]);

    await progress.pushToolProgress("🛠️ Second test run", { startImmediately: true });
    await progress.pushPlanProgress([
      { step: "Run tests", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ]);
    expect(progress.getSnapshot().lines).toEqual(["🛠️ Second test run"]);

    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "completed" },
    ]);
    expect(progress.getSnapshot().lines).toEqual([]);
    expect(await progress.pushToolProgress("🛠️ Late command", { startImmediately: true })).toBe(
      true,
    );
    expect(progress.getSnapshot().lines).toEqual(["🛠️ Late command"]);
  });

  it("keeps rolling lines across plan steps when scoping is not enabled", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update: vi.fn(),
    });

    await progress.pushPlanProgress([
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
    ]);
    await progress.pushToolProgress("🛠️ Inspect command", { startImmediately: true });
    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ]);

    expect(progress.getSnapshot().lines).toEqual(["🛠️ Inspect command"]);
  });

  it("rejects correlated tool updates from a retired plan step", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update: vi.fn(),
      resetRollingLinesOnPlanStepChange: true,
    });

    await progress.pushPlanProgress([
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
    ]);
    await progress.pushToolEvent({
      toolCallId: "inspect-1",
      name: "Read",
      phase: "start",
    });
    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ]);
    expect(progress.getSnapshot().lines).toEqual([]);

    await progress.pushItemEvent({
      toolCallId: "inspect-1",
      kind: "tool",
      name: "Read",
      phase: "end",
      status: "completed",
    });
    expect(progress.getSnapshot().lines).toEqual([]);
  });

  it("binds item-first tool updates to the admitting plan step", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update: vi.fn(),
      resetRollingLinesOnPlanStepChange: true,
    });

    await progress.pushPlanProgress([
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
    ]);
    expect(
      await progress.pushItemEvent({
        toolCallId: "item-first-1",
        kind: "tool",
        name: "Read",
        phase: "end",
        status: "completed",
        progressText: "first result",
      }),
    ).toBe(true);

    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ]);
    expect(progress.getSnapshot().lines).toEqual([]);
    expect(
      await progress.pushItemEvent({
        toolCallId: "item-first-1",
        kind: "tool",
        name: "Read",
        phase: "end",
        status: "completed",
        progressText: "late result",
      }),
    ).toBe(false);
    expect(progress.getSnapshot().lines).toEqual([]);
  });

  it("clears ambiguous duplicate-labeled step transitions", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update: vi.fn(),
      resetRollingLinesOnPlanStepChange: true,
    });

    await progress.pushPlanProgress([
      { step: "Run tests", status: "in_progress" },
      { step: "Run tests", status: "pending" },
    ]);
    await progress.pushToolProgress("🛠️ First run", { startImmediately: true });
    await progress.pushPlanProgress([{ step: "Run tests", status: "in_progress" }]);
    expect(progress.getSnapshot().lines).toEqual([]);

    await progress.pushToolProgress("🛠️ Current run", { startImmediately: true });
    await progress.pushPlanProgress([
      { step: "Run tests", status: "completed" },
      { step: "Run tests", status: "in_progress" },
    ]);
    expect(progress.getSnapshot().lines).toEqual([]);
  });

  it("lets plan-generation-aware renderers drop in-flight stale updates", async () => {
    let releaseLateUpdate = () => {};
    const lateUpdateReleased = new Promise<void>((resolve) => {
      releaseLateUpdate = resolve;
    });
    let markLateUpdateStarted = () => {};
    const lateUpdateStarted = new Promise<void>((resolve) => {
      markLateUpdateStarted = resolve;
    });
    const visibleUpdates: string[] = [];
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      resetRollingLinesOnPlanStepChange: true,
      update: async (text, options) => {
        if (options?.lines?.length) {
          markLateUpdateStarted();
          await lateUpdateReleased;
        }
        const generationAwareOptions = options as typeof options & {
          isCurrentPlanGeneration?: () => boolean;
        };
        if (generationAwareOptions?.isCurrentPlanGeneration?.() === false) {
          return false;
        }
        visibleUpdates.push(`${text}\n${JSON.stringify(options?.lines ?? [])}`);
        return true;
      },
    });

    await progress.pushPlanProgress([
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
    ]);
    const lateToolUpdate = progress.pushToolEvent({
      toolCallId: "inspect-late",
      name: "Read",
      phase: "start",
    });
    await lateUpdateStarted;
    await progress.pushPlanProgress([
      { step: "Inspect", status: "completed" },
      { step: "Patch", status: "in_progress" },
    ]);
    releaseLateUpdate();
    await lateToolUpdate;

    expect(visibleUpdates.at(-1)).toContain("▸ Patch");
    expect(visibleUpdates.at(-1)).not.toContain("Read");
  });

  it("publishes partial-preview tool lines without enabling progress-only plans", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "partial", progress: { label: false } } },
      mode: "partial",
      active: true,
      seed: "preview",
      update,
    });

    await progress.pushToolProgress("Inspecting files");
    expect(update).toHaveBeenLastCalledWith("• Inspecting files", {
      lines: ["Inspecting files"],
    });
    expect(await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }])).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("returns detached structured state for channel-native renderers", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      update: vi.fn(),
    });

    await progress.pushPreambleHeadline("Checking Slack.");
    await progress.pushToolProgress(
      { id: "tool-call-1", kind: "tool", text: "🛠️ Exec", label: "Exec", toolName: "exec" },
      { startImmediately: true },
    );
    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
      explanation: "Applying the change.",
    });

    const snapshot = progress.getSnapshot();
    expect(snapshot).toEqual({
      lines: [
        {
          id: "tool-call-1",
          kind: "tool",
          text: "🛠️ Exec",
          label: "Exec",
          toolName: "exec",
        },
      ],
      statusHeadline: "Checking Slack.",
      plan: [{ step: "Patch", status: "in_progress" }],
      planExplanation: "Applying the change.",
    });

    const snapshotLine = snapshot.lines[0];
    if (typeof snapshotLine !== "object") {
      throw new Error("expected structured snapshot line");
    }
    snapshotLine.text = "mutated";
    snapshot.plan![0]!.step = "mutated";
    expect(progress.getSnapshot()).toEqual({
      lines: [
        {
          id: "tool-call-1",
          kind: "tool",
          text: "🛠️ Exec",
          label: "Exec",
          toolName: "exec",
        },
      ],
      statusHeadline: "Checking Slack.",
      plan: [{ step: "Patch", status: "in_progress" }],
      planExplanation: "Applying the change.",
    });
  });

  it("keeps the progress label visible when tool lines are hidden", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling", toolProgress: false } },
      },
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });

    expect(update).toHaveBeenCalledWith("Shelling", { flush: true, lines: [] });
  });

  it("gates window thinking on its own flag, independent of tool progress", async () => {
    // thinking: false hides thoughts even though toolProgress stays on…
    const hiddenUpdate = vi.fn();
    const hidden = createTestProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
      reasoningGate: false,
      update: hiddenUpdate,
    });
    await hidden.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await hidden.pushReasoningProgress("Reading files");
    expect(hiddenUpdate.mock.calls.every(([text]) => !String(text).includes("Reading"))).toBe(true);

    const defaultUpdate = vi.fn();
    const sharedDefault = createTestProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
      update: defaultUpdate,
    });
    await sharedDefault.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await sharedDefault.pushReasoningProgress("Reading files");
    expect(defaultUpdate.mock.calls.every(([text]) => !String(text).includes("Reading"))).toBe(
      true,
    );

    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
      reasoningLinePrefix: "🧠 ",
      reasoningGate: true,
      update,
    });
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Reading files");
    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🧠 _Reading files_", {
      lines: ["🧠 _Reading files_"],
    });
  });

  it("shares reasoning merge state with legacy preview renderers", () => {
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "partial" } },
      mode: "partial",
      active: false,
      seed: "test",
      update: vi.fn(),
    });

    expect(progress.mergeReasoningProgress("Reading")).toBe("Reading");
    expect(progress.mergeReasoningProgress(" the Slack handler")).toBe("Reading the Slack handler");
    progress.resetReasoningProgress();
    expect(progress.mergeReasoningProgress("Checking again")).toBe("Checking again");
  });

  it("re-arms the draft for a queued turn after the primary final settled", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      update,
    });

    progress.markFinalReplyStarted();
    progress.markFinalReplyDelivered();
    expect(await progress.pushReasoningProgress("queued-turn thinking")).toBe(false);

    // New assistant message boundary on a queued/followup turn.
    expect(progress.beginNewTurn()).toBe(true);
    expect(progress.hasStarted).toBe(false);
    await progress.start();
    await progress.pushReasoningProgress("queued-turn thinking", { snapshot: true });

    expect(update).toHaveBeenCalled();
    expect(progress.beginNewTurn()).toBe(false);
  });

  it("force-rearms an authoritative queued boundary without a prior final", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      update,
    });

    await progress.pushToolProgress("first turn", { startImmediately: true });
    expect(progress.beginNewTurn()).toBe(false);
    expect(progress.beginNewTurn({ force: true })).toBe(true);
    await progress.pushToolProgress("queued turn", { startImmediately: true });

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n• queued turn", expect.anything());
  });

  it("cancels a delayed draft when the final reply starts", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        update,
      });

      await progress.pushToolProgress("🛠️ Exec");
      progress.markFinalReplyStarted();
      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);

      expect(progress.hasStarted).toBe(false);
      expect(update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect progress after suppression", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      update,
    });

    progress.suppress();
    await progress.pushReasoningProgress("Reading files");

    expect(update).not.toHaveBeenCalled();
  });

  it("composes reasoning deltas with tool progress", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Reading");
    await progress.pushReasoningProgress(" files");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Reading files_", {
      lines: ["🛠️ Exec", "🧠 _Reading files_"],
    });
  });

  it("labels window narration with a 💬 prefix", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      commentaryLinePrefix: "💬 ",
      update,
    });

    const rejected = await progress.pushCommentaryProgress(
      "[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]",
      { itemId: "silent" },
    );
    const accepted = await progress.pushCommentaryProgress("Checking the workspace", {
      itemId: "c1",
    });

    const rendered = update.mock.calls.map((call) => call[0]);
    expect(rejected).toBe(false);
    expect(accepted).toBe(true);
    expect(rendered).toContain("Shelling\n\n💬 _Checking the workspace_");
  });

  it("collapses cumulative id-less commentary snapshots onto one line", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      commentaryLinePrefix: "💬 ",
      update,
    });

    expect(await progress.pushCommentaryProgress("Checking")).toBe(true);
    expect(await progress.pushCommentaryProgress("Checking the workspace")).toBe(true);
    expect(await progress.pushCommentaryProgress("Checking the workspace before answering.")).toBe(
      true,
    );

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n💬 _Checking the workspace before answering._",
      {
        lines: [
          expect.objectContaining({
            text: "💬 _Checking the workspace before answering._",
            kind: "item",
            label: "Commentary",
          }),
        ],
      },
    );
    expect(progress.getSnapshot().lines).toHaveLength(1);
  });

  it("appends genuinely distinct id-less commentary as separate lines", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      commentaryLinePrefix: "💬 ",
      update,
    });

    expect(await progress.pushCommentaryProgress("Checking the workspace")).toBe(true);
    expect(await progress.pushCommentaryProgress("Writing the patch next")).toBe(true);

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n💬 _Checking the workspace_\n💬 _Writing the patch next_",
      {
        lines: [
          expect.objectContaining({ text: "💬 _Checking the workspace_" }),
          expect.objectContaining({ text: "💬 _Writing the patch next_" }),
        ],
      },
    );
  });

  it("updates an id-less commentary line in place after a later tool line", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      commentaryLinePrefix: "💬 ",
      update,
    });

    await progress.pushCommentaryProgress("Checking");
    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushCommentaryProgress("Checking the workspace");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n💬 _Checking the workspace_\n🛠️ Exec", {
      lines: [expect.objectContaining({ text: "💬 _Checking the workspace_" }), "🛠️ Exec"],
    });
  });

  it("keeps id-less commentary when a later snapshot sanitizes to empty", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      commentaryLinePrefix: "💬 ",
      update,
    });

    expect(await progress.pushCommentaryProgress("Checking the workspace")).toBe(true);
    const callsAfterValid = update.mock.calls.length;
    expect(
      await progress.pushCommentaryProgress("[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]"),
    ).toBe(false);

    expect(update).toHaveBeenCalledTimes(callsAfterValid);
    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n💬 _Checking the workspace_",
      expect.objectContaining({
        lines: [expect.objectContaining({ text: "💬 _Checking the workspace_" })],
      }),
    );
    expect(progress.getSnapshot().lines).toHaveLength(1);
  });

  it("replaces and retracts commentary by itemId", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      commentaryLinePrefix: "💬 ",
      update,
    });

    expect(await progress.pushCommentaryProgress("First note", { itemId: "c1" })).toBe(true);
    expect(await progress.pushCommentaryProgress("Updated note", { itemId: "c1" })).toBe(true);
    expect(await progress.pushCommentaryProgress("Other note", { itemId: "c2" })).toBe(true);
    expect(progress.getSnapshot().lines).toHaveLength(2);
    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n💬 _Updated note_\n💬 _Other note_",
      expect.objectContaining({
        lines: [
          expect.objectContaining({ id: "commentary:c1", text: "💬 _Updated note_" }),
          expect.objectContaining({ id: "commentary:c2", text: "💬 _Other note_" }),
        ],
      }),
    );

    expect(await progress.pushCommentaryProgress("", { itemId: "c1" })).toBe(false);
    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n💬 _Other note_",
      expect.objectContaining({
        lines: [expect.objectContaining({ id: "commentary:c2", text: "💬 _Other note_" })],
      }),
    );
  });

  it.each([
    {
      presentation: undefined,
      text: "Shelling\n\n🧠 _Listing the workspace_\n🛠️ ls\n🧠 _Picking the largest_\n🛠️ wc",
      lines: ["🧠 _Listing the workspace_", "🛠️ ls", "🧠 _Picking the largest_", "🛠️ wc"],
    },
    {
      presentation: "summary" as const,
      text: "Shelling\n\nPicking the largest",
      lines: [
        {
          id: "reasoning",
          kind: "item",
          text: "Picking the largest",
          label: "Reasoning",
          prefix: false,
        },
      ],
    },
  ])(
    "keeps reasoning bursts separate across tools ($presentation)",
    async ({ presentation, text, lines }) => {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: {
          streaming: { mode: "progress", progress: { label: "Shelling", maxLines: 8 } },
        },
        presentation,
        reasoningLinePrefix: "🧠 ",
        update,
      });

      // Hidden tools still delimit reasoning bursts in summary presentation.
      await progress.pushReasoningProgress("Listing the workspace");
      await progress.pushToolProgress("🛠️ ls", { startImmediately: true });
      await progress.pushReasoningProgress("Picking the largest");
      await progress.pushToolProgress("🛠️ wc", { startImmediately: true });

      expect(update).toHaveBeenLastCalledWith(text, { lines });
      progress.cancel();
    },
  );

  it("preserves tagged reasoning content without leaking tags", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("<think>Checking files</think>Final answer prose");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Checking files_", {
      lines: ["🛠️ Exec", "🧠 _Checking files_"],
    });
  });

  it("waits for complete reasoning tags before showing tagged progress", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    const calls = update.mock.calls.length;
    await progress.pushReasoningProgress("<thin");

    expect(update.mock.calls).toHaveLength(calls);
  });

  it("preserves partial reasoning tag buffers across deltas", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("<thin");
    await progress.pushReasoningProgress("k>Checking files</think>Final answer prose");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Checking files_", {
      lines: ["🛠️ Exec", "🧠 _Checking files_"],
    });
  });

  it("keeps literal reasoning tags inside code blocks", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("```html\n<think>literal</think>\n```");

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\n🛠️ Exec\n🧠 _```html <think>literal</think> ```_",
      {
        lines: ["🛠️ Exec", "🧠 _```html <think>literal</think> ```_"],
      },
    );
  });

  it("replaces repeated formatted reasoning snapshots", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      reasoningLinePrefix: "🧠 ",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushReasoningProgress("Thinking\n\n_Reading_");
    await progress.pushReasoningProgress("Thinking\n\n_Reading files_");

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🧠 _Reading files_", {
      lines: ["🛠️ Exec", "🧠 _Reading files_"],
    });
  });

  it("keeps tool lines under narration and drops redundant edits", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushToolProgress("🛠️ Exec", { startImmediately: true });
    await progress.pushNarrationProgress("Updating the config file now.");
    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nUpdating the config file now.\n\n🛠️ Exec",
      expect.anything(),
    );

    // Tool events stay visible under the headline, so each new line edits.
    await progress.pushToolProgress("🛠️ Wc", { startImmediately: true });
    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nUpdating the config file now.\n\n🛠️ Exec\n🛠️ Wc",
      expect.anything(),
    );

    // Identical narration is dropped; changed narration edits once.
    expect(await progress.pushNarrationProgress("Updating the config file now.")).toBe(false);
    await progress.pushNarrationProgress("Restarting the gateway.");
    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nRestarting the gateway.\n\n🛠️ Exec\n🛠️ Wc",
      expect.anything(),
    );

    // Narration stopping (empty update) leaves the raw tool lines.
    await progress.pushNarrationProgress("");
    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Exec\n🛠️ Wc", expect.anything());
  });

  it("normalizes transport-neutral agent events through the compositor", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress" } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.start();
    await progress.pushToolEvent({
      itemId: "tool-1",
      name: "exec",
      phase: "start",
      args: { command: "pnpm test" },
      detailMode: "raw",
    });
    await progress.pushItemEvent({
      itemId: "item-1",
      kind: "search",
      progressText: "found tests",
    });
    await progress.pushApprovalEvent({ phase: "requested", command: "pnpm test" });
    await progress.pushCommandOutputEvent({
      itemId: "command-1",
      phase: "end",
      name: "exec",
      exitCode: 0,
    });
    await progress.pushPatchEvent({
      itemId: "patch-1",
      phase: "end",
      modified: ["src/example.ts"],
    });
    await progress.pushApprovalEvent({ phase: "resolved", command: "ignored" });
    await progress.pushApprovalEvent({ command: "ignored without phase" });
    await progress.pushCommandOutputEvent({ phase: "start", title: "ignored" });
    await progress.pushCommandOutputEvent({ title: "ignored without phase" });
    await progress.pushPatchEvent({ phase: "start", modified: ["ignored.ts"] });
    await progress.pushPatchEvent({ modified: ["ignored-without-phase.ts"] });

    expect(progress.getSnapshot().lines).toEqual([
      expect.objectContaining({ id: "tool-1", kind: "tool", toolName: "exec" }),
      expect.objectContaining({ id: "item-1", kind: "item", toolName: "web_search" }),
      expect.objectContaining({ kind: "approval", status: "requested" }),
      expect.objectContaining({ id: "command-1", kind: "command-output", status: "completed" }),
      expect.objectContaining({ id: "patch-1", kind: "patch", toolName: "apply_patch" }),
    ]);
    expect(progress.getSnapshot().diffStat).toBeUndefined();
  });

  it("wires successful mutation completions into the snapshot diff stat", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Working" } } },
      update: vi.fn(),
      updateOnLineChange: true,
    });

    await progress.pushToolEvent({
      toolCallId: "write-1",
      name: "write",
      phase: "start",
      args: { path: "src/example.ts", content: "one\ntwo" },
    });
    expect(progress.getSnapshot().diffStat).toBeUndefined();
    await progress.pushItemEvent({
      toolCallId: "write-1",
      kind: "tool",
      phase: "end",
      status: "completed",
    });
    expect(progress.getSnapshot().diffStat).toEqual({ files: 1, added: 2, removed: 0 });
  });

  it("ignores status updates once the final reply started and clears both per turn", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      update,
    });

    await progress.start();
    expect(progress.isVisible).toBe(true);
    await progress.pushPreambleHeadline("Checking the primary turn.");
    await progress.pushNarrationProgress("Working on it.");
    progress.markFinalReplyStarted();
    expect(progress.isVisible).toBe(false);
    expect(await progress.pushPreambleHeadline("Too late.")).toBe(false);
    expect(await progress.pushNarrationProgress("Too late.")).toBe(false);

    progress.markFinalReplyDelivered();
    progress.beginNewTurn();
    await progress.pushToolProgress("🛠️ Next", { startImmediately: true });
    // The queued turn starts without either primary-turn status source.
    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Next", expect.anything());
  });

  it("logs a timer-fired start failure via the gate's default boundary logger", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new Error("send failed");
      const update = vi.fn().mockRejectedValue(error);
      const progress = createTestProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        update,
      });

      await progress.pushToolProgress("🛠️ Exec");
      expect(warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);

      expect(update).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[progress-draft] channel progress draft failed to start: Error: send failed",
      );
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});
