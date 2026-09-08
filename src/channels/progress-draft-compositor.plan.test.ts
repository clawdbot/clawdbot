import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

describe("progress draft plan lifecycle", () => {
  it.each(["partial", "block", "progress"] as const)(
    "preserves the plan across message and answer boundaries in %s mode",
    async (mode) => {
      const update = vi.fn();
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode, progress: { label: false, toolProgress: true } } },
        mode,
        active: true,
        seed: "lifecycle",
        update,
      });
      const plan = [{ step: "Patch", status: "in_progress" as const }];
      const explanation = "0/1 complete";

      await progress.pushPlanProgress(plan, { explanation });
      await progress.pushToolProgress("Inspecting files", { startImmediately: true });
      progress.beginAssistantMessage();
      await progress.pushItemEvent({
        itemId: "blocked-card",
        kind: "tool",
        name: "progress_card",
        phase: "end",
        status: "blocked",
      });
      const retainedActivity = [
        "Inspecting files",
        expect.objectContaining({ id: "blocked-card", status: "blocked" }),
      ];
      expect(update).toHaveBeenLastCalledWith(
        expect.stringContaining("▸ Patch"),
        expect.objectContaining({
          snapshot: expect.objectContaining({
            plan,
            planExplanation: explanation,
            lines: retainedActivity,
          }),
        }),
      );

      progress.beginAssistantMessage();
      expect(await progress.pushPlanProgress([])).toBe(true);
      expect(progress.getSnapshot()).toEqual({ lines: retainedActivity });
      expect(update).toHaveBeenLastCalledWith(
        expect.stringContaining("Inspecting files"),
        expect.objectContaining({ snapshot: { lines: retainedActivity } }),
      );

      await progress.pushPlanProgress(plan, { explanation });
      progress.resetActivity({ suppressed: true });
      expect(await progress.pushToolProgress("Hidden activity")).toBe(false);
      progress.beginAssistantMessage();
      expect(await progress.pushToolProgress("Verifying files", { startImmediately: true })).toBe(
        true,
      );
      expect(update).toHaveBeenLastCalledWith(
        "0/1 complete\n\n• Verifying files\n▸ Patch",
        expect.objectContaining({
          snapshot: {
            lines: ["Verifying files"],
            plan,
            planExplanation: explanation,
            statusHeadline: explanation,
          },
        }),
      );

      expect(progress.beginNewTurn({ force: true })).toBe(true);
      expect(progress.getSnapshot()).toEqual({ lines: [] });
      await progress.pushPlanProgress(plan, { explanation });
      progress.reset();
      expect(progress.getSnapshot()).toEqual({ lines: [] });
    },
  );

  it("starts immediately for plans, replaces snapshots, and clears them on reset", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      mode: "progress",
      active: true,
      seed: "test",
      entry: { streaming: { mode: "progress", progress: { toolProgress: true, label: false } } },
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
    const progress = createChannelProgressDraftCompositor({
      mode: "progress",
      active: true,
      seed: "test",
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
    expect(update).toHaveBeenLastCalledWith(
      "Applying the change.\n\n▸ Patch",
      expect.objectContaining({
        flush: true,
        lines: [],
      }),
    );
  });

  it.each(["partial", "block", "progress"] as const)(
    "replaces the full checklist and preserves other activity on clear in %s mode",
    async (mode) => {
      const update = vi.fn();
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode, progress: { label: false, toolProgress: true } } },
        mode,
        active: true,
        seed: "preview",
        update,
      });

      await progress.pushToolProgress("Inspecting files", { startImmediately: true });
      expect(update).toHaveBeenLastCalledWith(
        "• Inspecting files",
        expect.objectContaining({
          lines: ["Inspecting files"],
        }),
      );
      expect(
        await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
          explanation: "0/1 complete",
        }),
      ).toBe(true);
      expect(update).toHaveBeenLastCalledWith(
        "0/1 complete\n\n• Inspecting files\n▸ Patch",
        expect.objectContaining({
          lines: ["Inspecting files"],
          snapshot: {
            lines: ["Inspecting files"],
            statusHeadline: "0/1 complete",
            plan: [{ step: "Patch", status: "in_progress" }],
            planExplanation: "0/1 complete",
          },
        }),
      );
      await progress.pushPlanProgress([{ step: "Patch", status: "completed" }], {
        explanation: "1/1 complete",
      });
      expect(update).toHaveBeenLastCalledWith(
        "1/1 complete\n\n• Inspecting files\n✅ Patch",
        expect.objectContaining({
          lines: ["Inspecting files"],
        }),
      );
      expect(await progress.pushPlanProgress([])).toBe(true);
      expect(update).toHaveBeenLastCalledWith(
        "• Inspecting files",
        expect.objectContaining({
          snapshot: { lines: ["Inspecting files"] },
        }),
      );
      expect(await progress.pushPlanProgress([{ step: "Verify", status: "in_progress" }])).toBe(
        true,
      );
      expect(update).toHaveBeenLastCalledWith("• Inspecting files\n▸ Verify", expect.anything());
    },
  );

  it.each(
    (["partial", "block", "progress"] as const).flatMap((mode) =>
      [undefined, false, "Custom progress"].map((label) => ({ mode, label })),
    ),
  )(
    "deletes an empty card and recreates identical content in $mode mode with label $label",
    async ({ mode, label }) => {
      const update = vi.fn();
      const deleteCurrent = vi.fn();
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode, progress: { label } } },
        mode,
        active: true,
        seed: "preview",
        update,
        deleteCurrent,
      });

      await progress.pushPlanProgress([]);
      expect(update).not.toHaveBeenCalled();
      deleteCurrent.mockClear();

      expect(await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }])).toBe(
        true,
      );
      expect(await progress.pushPlanProgress([])).toBe(true);
      expect(deleteCurrent).toHaveBeenCalledTimes(1);
      expect(progress.isVisible).toBe(false);
      expect(progress.getSnapshot()).toEqual(expect.objectContaining({ lines: [] }));
      expect(await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }])).toBe(
        true,
      );
      expect(update).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenLastCalledWith(
        expect.stringContaining("▸ Patch"),
        expect.anything(),
      );
    },
  );

  it.each(
    (["partial", "block", "progress"] as const).flatMap((mode) =>
      [undefined, false, "Custom progress"].map((label) => ({ mode, label })),
    ),
  )(
    "replaces a plan without deletion support in $mode mode with label $label",
    async ({ mode, label }) => {
      const update = vi.fn();
      const progress = createChannelProgressDraftCompositor({
        entry: { streaming: { mode, progress: { label } } },
        mode,
        active: true,
        seed: "preview",
        update,
      });

      await progress.pushPlanProgress([]);
      expect(update).not.toHaveBeenCalled();
      await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }]);
      expect(await progress.pushPlanProgress([])).toBe(label !== false);
      if (label !== false) {
        expect(update.mock.lastCall?.[0]).toBe(label ?? "Working");
      }
      await progress.pushPlanProgress([{ step: "Verify", status: "in_progress" }]);
      expect(update.mock.lastCall?.[0]).toContain("▸ Verify");
      expect(update.mock.lastCall?.[0]).not.toContain("Patch");
    },
  );

  it("returns detached structured state for channel-native renderers", async () => {
    const update = vi.fn<Parameters<typeof createChannelProgressDraftCompositor>[0]["update"]>();
    const progress = createChannelProgressDraftCompositor({
      mode: "progress",
      active: true,
      seed: "test",
      entry: { streaming: { mode: "progress", progress: { toolProgress: true, label: false } } },
      update,
    });

    await progress.pushPreambleHeadline("Checking Slack.");
    await progress.pushToolProgress(
      { id: "tool-call-1", kind: "tool", text: "🛠️ Exec", label: "Exec", toolName: "exec" },
      { startImmediately: true },
    );
    await progress.pushPlanProgress([{ step: "Patch", status: "in_progress" }], {
      explanation: "Applying the change.",
    });

    const snapshot = update.mock.lastCall?.[1]?.snapshot;
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

    if (!snapshot) {
      throw new Error("expected delivered render snapshot");
    }
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
});
