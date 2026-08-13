import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;

function createProgress(update: () => Promise<boolean | void> | boolean | void) {
  return createChannelProgressDraftCompositor({
    entry: { streaming: { mode: "progress", progress: { label: "Working" } } },
    mode: "progress",
    active: true,
    seed: "test",
    update,
  });
}

describe("progress draft visibility", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["sync void", () => undefined],
    ["async void", async () => undefined],
    ["explicit true", async () => true],
  ])("treats %s as accepted legacy-visible progress", async (_label, update) => {
    vi.useFakeTimers();
    const progress = createProgress(update);

    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(false);
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);

    expect(progress.isVisible).toBe(true);
  });

  it("keeps explicit false pending and retryable", async () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const progress = createProgress(update);

    await progress.pushToolProgress("🛠️ Exec");
    await vi.advanceTimersByTimeAsync(DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS);
    expect(progress.isVisible).toBe(false);

    expect(await progress.pushToolProgress("🛠️ Exec")).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    expect(progress.isVisible).toBe(true);
  });

  it("does not dedupe a rejected update", async () => {
    const update = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const progress = createProgress(update);

    expect(await progress.pushToolProgress("🛠️ Exec", { startImmediately: true })).toBe(false);
    expect(await progress.pushToolProgress("🛠️ Exec", { startImmediately: true })).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
  });
});
