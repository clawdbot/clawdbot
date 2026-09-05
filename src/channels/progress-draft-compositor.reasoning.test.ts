// Reasoning progress tests cover immediate and delayed channel draft publication.
import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

describe("createChannelProgressDraftCompositor reasoning", () => {
  it("starts reasoning immediately only when requested", async () => {
    vi.useFakeTimers();
    try {
      const delayedUpdate = vi.fn();
      const delayed = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        mode: "progress",
        active: true,
        seed: "delayed",
        reasoningLinePrefix: "🧠 ",
        update: delayedUpdate,
      });
      const immediateUpdate = vi.fn();
      const immediate = createChannelProgressDraftCompositor({
        entry: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
        mode: "progress",
        active: true,
        seed: "immediate",
        reasoningLinePrefix: "🧠 ",
        update: immediateUpdate,
      });

      await delayed.pushReasoningProgress("Reading files");
      await immediate.pushReasoningProgress("Reading files", { startImmediately: true });

      expect(delayed.hasStarted).toBe(false);
      expect(delayedUpdate).not.toHaveBeenCalled();
      expect(immediate.hasStarted).toBe(true);
      expect(immediateUpdate).toHaveBeenCalledWith("Shelling\n\n🧠 _Reading files_", {
        flush: true,
        lines: ["🧠 _Reading files_"],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
