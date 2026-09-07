import { expect, it, vi } from "vitest";
import {
  createChannelProgressDraftCompositor,
  PROGRESS_STATUS_PREAMBLE_FRESH_MS,
} from "./progress-draft-compositor.js";

it("hands the headline to narration and back without changing commentary history", async () => {
  vi.useFakeTimers();
  const update = vi.fn();
  const progress = createChannelProgressDraftCompositor({
    mode: "progress",
    active: true,
    seed: "test",
    entry: {
      streaming: {
        mode: "progress",
        progress: { commentary: true, toolProgress: true, label: false, maxLines: 2 },
      },
    },
    update,
  });
  const first = "Reading the workspace.";
  const narration = "Comparing the configuration now.";
  const next = "Preparing the focused fix.";
  try {
    await progress.start();
    await progress.pushPreambleHeadline(first, { itemId: "first", deferRender: true });
    await progress.pushCommentaryProgress(first, { itemId: "first" });
    await progress.pushNarrationProgress(narration);

    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1);
    expect(update.mock.lastCall?.[0]).toBe(`${first}\n\n_${first}_`);
    const history = progress.getSnapshot().lines;

    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.lastCall?.[0]).toBe(`${narration}\n\n_${first}_`);
    expect(progress.getSnapshot().lines).toEqual(history);

    await progress.pushPreambleHeadline(next, { itemId: "next", deferRender: true });
    await progress.pushCommentaryProgress(next, { itemId: "next" });
    expect(update.mock.lastCall?.[0]).toBe(`${next}\n\n_${first}_\n_${next}_`);

    await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS - 1);
    expect(update.mock.lastCall?.[0]).toBe(`${next}\n\n_${first}_\n_${next}_`);
    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.lastCall?.[0]).toBe(`${narration}\n\n_${first}_\n_${next}_`);

    await progress.pushToolProgress("Tool activity", { startImmediately: true });
    expect(update.mock.lastCall?.[0]).toBe(`${narration}\n\n_${next}_\n• Tool activity`);
    await progress.pushNarrationProgress("");
    expect(update.mock.lastCall?.[0]).toBe(`${next}\n\n_${next}_\n• Tool activity`);
  } finally {
    progress.cancel();
    vi.useRealTimers();
  }
});
