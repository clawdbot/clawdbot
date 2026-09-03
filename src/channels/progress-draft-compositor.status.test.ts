// Status-headline tests are split from the core compositor suite to keep both files bounded.
import { describe, expect, it, vi } from "vitest";
import {
  createChannelProgressDraftCompositor,
  PROGRESS_STATUS_PREAMBLE_FRESH_MS,
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

describe("createChannelProgressDraftCompositor status headlines", () => {
  it("hands preambles to the commentary lane when it is enabled", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Shelling", commentary: true } },
      },
      update,
    });

    // The opt-in 💬 lane renders every preamble as an interleaved line; the
    // headline must decline so it cannot replace those documented lines.
    expect(await progress.pushPreambleHeadline("Reading the workspace.")).toBe(false);
    expect(progress.hasStatusHeadline).toBe(false);
  });

  it("derives a stable headline from plan state when authored status is absent", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: {
        streaming: { mode: "progress", progress: { label: "Working", commentary: true } },
      },
      update,
      derivePlanStatusHeadline: true,
    });

    await progress.pushPlanProgress([
      { step: "Read system time", status: "completed" },
      { step: "Read   kernel version", status: "in_progress" },
      { step: "Read disk usage", status: "pending" },
    ]);
    expect(progress.getSnapshot().statusHeadline).toBe("⏳ 2/3 · Read kernel version");
    expect(update).toHaveBeenLastCalledWith(
      "Working\n\n⏳ 2/3 · Read kernel version\n\n✅ Read system time\n▸ Read kernel version\n▢ Read disk usage",
      expect.objectContaining({ flush: true }),
    );

    await progress.pushPlanProgress([
      { step: "Read system time", status: "completed" },
      { step: "Read kernel version", status: "completed" },
      { step: "Read disk usage", status: "pending" },
    ]);
    expect(progress.getSnapshot().statusHeadline).toBe("⏳ 3/3 · Read disk usage");

    await progress.pushPlanProgress([
      { step: "Read system time", status: "completed" },
      { step: "Read kernel version", status: "completed" },
      { step: "Read disk usage", status: "completed" },
    ]);
    expect(progress.getSnapshot().statusHeadline).toBe("✅ 3/3");
  });

  it("does not derive a plan headline unless the channel opts in", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Working" } } },
      update: vi.fn(),
    });

    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }]);

    expect(progress.getSnapshot().statusHeadline).toBeUndefined();
  });

  it("keeps an authored plan explanation ahead of the derived plan headline", async () => {
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Working" } } },
      update: vi.fn(),
      derivePlanStatusHeadline: true,
    });

    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
      explanation: "Applying the revised plan.",
    });

    expect(progress.getSnapshot().statusHeadline).toBe("Applying the revised plan.");
  });

  it("holds a preamble headline until the gate starts and hides the implicit label", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress" } },
      update,
    });

    expect(await progress.pushPreambleHeadline("  Reading\n the workspace. ")).toBe(false);
    expect(await progress.pushPreambleHeadline("   ")).toBe(false);
    expect(progress.hasStarted).toBe(false);
    expect(update).not.toHaveBeenCalled();

    await progress.start();

    expect(update).toHaveBeenCalledWith("Reading the workspace.", { flush: true, lines: [] });
  });

  it("publishes rolling tool-line changes beneath a stable preamble headline", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { maxLines: 8 } } },
      updateOnLineChange: true,
      update,
    });

    await progress.pushPreambleHeadline("Reading the workspace.");
    await progress.pushToolProgress("🛠️ Exec one", { startImmediately: true });
    await progress.pushToolProgress("🛠️ Exec two", { startImmediately: true });

    expect(update).toHaveBeenLastCalledWith("Reading the workspace.\n\n🛠️ Exec one\n🛠️ Exec two", {
      lines: ["🛠️ Exec one", "🛠️ Exec two"],
    });
  });

  it("rejects control-only preambles without clobbering a valid headline", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress" } },
      now: () => nowMs,
      update,
    });

    expect(progress.hasStatusHeadline).toBe(false);
    expect(await progress.pushPreambleHeadline("[[reply_to_current]]")).toBe(false);
    expect(progress.hasStatusHeadline).toBe(false);
    await progress.pushPreambleHeadline(
      "[[reply_to_current]] Reading   the workspace. [[audio_as_voice]]",
    );
    expect(progress.hasStatusHeadline).toBe(true);
    await progress.start();
    expect(update).toHaveBeenLastCalledWith("Reading the workspace.", {
      flush: true,
      lines: [],
    });

    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    const calls = update.mock.calls.length;
    expect(await progress.pushPreambleHeadline("[[reply_to_current]]")).toBe(false);
    expect(
      await progress.pushPreambleHeadline("[[reply_to_current]] ~~NO_REPLY~~ [[audio_as_voice]]"),
    ).toBe(false);
    expect(progress.hasStatusHeadline).toBe(true);
    expect(update).toHaveBeenCalledTimes(calls);

    await progress.pushNarrationProgress("Utility filler.");
    expect(update).toHaveBeenLastCalledWith("Utility filler.", expect.anything());
    await progress.pushNarrationProgress("");
    expect(update).toHaveBeenLastCalledWith("Reading the workspace.", expect.anything());
  });

  it("retracts only the matching preamble headline", async () => {
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.", { itemId: "preamble-1" });
    await progress.pushPreambleHeadline("Checking the config.", { itemId: "preamble-2" });
    const callsBeforeStaleRetraction = update.mock.calls.length;

    expect(await progress.pushPreambleHeadline("", { itemId: "preamble-1" })).toBe(false);
    expect(update).toHaveBeenCalledTimes(callsBeforeStaleRetraction);
    expect(progress.hasStatusHeadline).toBe(true);

    expect(await progress.pushPreambleHeadline("", { itemId: "preamble-2" })).toBe(true);
    expect(progress.hasStatusHeadline).toBe(false);
    expect(update).toHaveBeenLastCalledWith("Shelling", expect.anything());
  });

  it("keeps a fresh preamble ahead of later narration", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      now: () => nowMs,
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.");
    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1;
    await progress.pushNarrationProgress("Utility narration should wait.");

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nReading the workspace.",
      expect.anything(),
    );
  });

  it("uses newer narration after the preamble becomes stale", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      now: () => nowMs,
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.");
    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    await progress.pushNarrationProgress("Comparing the configuration now.");

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nComparing the configuration now.",
      expect.anything(),
    );
  });

  it("uses a plan explanation after the preamble becomes stale", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      now: () => nowMs,
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.");
    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
      explanation: "Applying the revised plan.",
    });

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nApplying the revised plan.\n\n▸ Patch",
      expect.anything(),
    );
  });

  it("refreshes a new preamble item when its text matches the stale item", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      now: () => nowMs,
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.", { itemId: "first" });
    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    await progress.pushNarrationProgress("Comparing the configuration now.");
    await progress.pushPreambleHeadline("Reading the workspace.", { itemId: "second" });

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nReading the workspace.",
      expect.anything(),
    );
  });

  it("refreshes to retained narration when a visible preamble expires", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        update,
      });

      await progress.start();
      await progress.pushPreambleHeadline("Reading the workspace.");
      await progress.pushNarrationProgress("Comparing the configuration now.");
      expect(update).toHaveBeenLastCalledWith(
        "Shelling\n\nReading the workspace.",
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS);

      expect(update).toHaveBeenLastCalledWith(
        "Shelling\n\nComparing the configuration now.",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending preamble-expiry refresh when the final starts", async () => {
    vi.useFakeTimers();
    try {
      const progress = createTestProgressDraftCompositor({
        entry: { streaming: { mode: "progress" } },
        update: vi.fn(),
      });

      await progress.start();
      await progress.pushPreambleHeadline("Reading the workspace.");
      await progress.pushNarrationProgress("Comparing the configuration now.");
      expect(vi.getTimerCount()).toBe(1);

      progress.markFinalReplyStarted();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the retained preamble when narration clears", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      now: () => nowMs,
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.");
    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    await progress.pushNarrationProgress("Comparing the configuration now.");
    await progress.pushNarrationProgress("");

    expect(update).toHaveBeenLastCalledWith(
      "Shelling\n\nReading the workspace.",
      expect.anything(),
    );
  });

  it("clears both status sources on reset", async () => {
    let nowMs = 0;
    const update = vi.fn();
    const progress = createTestProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      now: () => nowMs,
      update,
    });

    await progress.start();
    await progress.pushPreambleHeadline("Reading the workspace.");
    nowMs += PROGRESS_STATUS_PREAMBLE_FRESH_MS;
    await progress.pushNarrationProgress("Comparing the configuration now.");
    progress.reset();
    await progress.pushToolProgress("🛠️ Next", { startImmediately: true });

    expect(update).toHaveBeenLastCalledWith("Shelling\n\n🛠️ Next", expect.anything());
  });

  it("holds narration behind the initial progress delay", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn();
      const progress = createTestProgressDraftCompositor({
        entry: { streaming: { mode: "progress" } },
        update,
      });

      await progress.pushToolProgress("🛠️ Exec");
      await progress.pushNarrationProgress("Reading the gateway config.");

      expect(update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS - 1);
      expect(update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(update).toHaveBeenCalledWith("Reading the gateway config.\n\n🛠️ Exec", {
        flush: true,
        lines: ["🛠️ Exec"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
