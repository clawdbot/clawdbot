import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 1_500;

function createProgress(
  update: () => Promise<boolean | void> | boolean | void,
  overrides?: Pick<
    Parameters<typeof createChannelProgressDraftCompositor>[0],
    "entry" | "deleteCurrent"
  >,
) {
  return createChannelProgressDraftCompositor({
    entry: { streaming: { mode: "progress", progress: { label: "Working", commentary: true } } },
    mode: "progress",
    active: true,
    seed: "test",
    update,
    ...overrides,
  });
}

type Progress = ReturnType<typeof createProgress>;

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

  describe.each<{
    name: string;
    push: (progress: Progress) => Promise<boolean>;
    repeatFlush?: boolean;
  }>([
    {
      name: "tool",
      push: (progress) => progress.pushToolProgress("🛠️ Exec", { startImmediately: true }),
    },
    {
      name: "activity",
      push: (progress) => progress.noteActivity({ startImmediately: true }),
      repeatFlush: true,
    },
    {
      name: "plan",
      push: (progress) => progress.pushPlanProgress([{ step: "Inspect", status: "in_progress" }]),
    },
    {
      name: "commentary",
      push: (progress) => progress.pushCommentaryProgress("Inspecting", { itemId: "commentary-1" }),
    },
  ])("$name progress", ({ push, repeatFlush }) => {
    it("retries rejected updates with the caller's flush behavior", async () => {
      const update = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const progress = createProgress(update);

      expect(await push(progress)).toBe(false);
      expect(progress.isVisible).toBe(false);
      expect(await push(progress)).toBe(true);
      expect(progress.isVisible).toBe(true);
      expect(update.mock.calls.map(([, options]) => options.flush)).toEqual([true, repeatFlush]);
    });

    it("reports no progress when final delivery cancels pending startup", async () => {
      const started = createDeferred();
      const accepted = createDeferred<boolean>();
      const progress = createProgress(() => {
        started.resolve();
        return accepted.promise;
      });
      const result = push(progress);
      await started.promise;
      progress.markFinalReplyStarted();
      accepted.resolve(true);

      expect(await result).toBe(false);
      expect(progress.hasStarted).toBe(false);
      expect(progress.isVisible).toBe(false);
    });
  });

  it.each<{
    name: string;
    stage: (progress: Progress) => Promise<boolean>;
    clear: (progress: Progress) => Promise<boolean>;
  }>([
    {
      name: "plan",
      stage: (progress) => progress.pushPlanProgress([{ step: "Inspect", status: "in_progress" }]),
      clear: (progress) => progress.pushPlanProgress(),
    },
    {
      name: "preamble",
      stage: (progress) => progress.pushPreambleHeadline("Inspecting", { itemId: "preamble-1" }),
      clear: (progress) => progress.pushPreambleHeadline("", { itemId: "preamble-1" }),
    },
  ])("deletes a draft emptied by $name retraction only after startup", async ({ stage, clear }) => {
    const deleteCurrent = vi.fn();
    const progress = createProgress(vi.fn(), {
      entry: { streaming: { mode: "progress", progress: { label: false } } },
      deleteCurrent,
    });

    expect(await clear(progress)).toBe(false);
    expect(deleteCurrent).not.toHaveBeenCalled();
    await stage(progress);
    await progress.start();
    expect(progress.isVisible).toBe(true);

    expect(await clear(progress)).toBe(true);
    expect(deleteCurrent).toHaveBeenCalledTimes(1);
    expect(progress.isVisible).toBe(false);
  });
});
