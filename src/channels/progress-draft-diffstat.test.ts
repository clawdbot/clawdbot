import { describe, expect, it } from "vitest";
import { createProgressDraftDiffStatTracker } from "./progress-draft-diffstat.js";

type DiffStatTracker = ReturnType<typeof createProgressDraftDiffStatTracker>;

function stageMutation(
  tracker: DiffStatTracker,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  phase = "start",
) {
  tracker.stageToolEvent({ toolCallId, name, phase, args });
}

function completeMutation(tracker: DiffStatTracker, toolCallId: string, status = "completed") {
  tracker.commitItemEvent({ toolCallId, phase: "end", status });
}

describe("createProgressDraftDiffStatTracker", () => {
  it("stages starts and commits successful terminal items additively", () => {
    const tracker = createProgressDraftDiffStatTracker({ canStage: () => true });

    stageMutation(tracker, "write-1", "write", {
      path: "src/example.ts",
      content: "one\ntwo",
    });
    expect(tracker.resolve()).toBeUndefined();
    stageMutation(
      tracker,
      "write-1",
      "write",
      { path: "src/example.ts", content: "ignored\npartial\nargs" },
      "update",
    );
    expect(tracker.resolve()).toBeUndefined();

    completeMutation(tracker, "write-1");
    expect(tracker.resolve()).toEqual({ files: 1, added: 2, removed: 0 });

    stageMutation(tracker, "edit-1", "edit", {
      path: "src/example.ts",
      edits: [{ oldText: "one\ntwo", newText: "three" }],
    });
    completeMutation(tracker, "edit-1");
    expect(tracker.resolve()).toEqual({ files: 1, added: 3, removed: 2 });

    for (const status of ["failed", "error"]) {
      const toolCallId = `failed-${status}`;
      stageMutation(tracker, toolCallId, "write", {
        path: `src/${toolCallId}.ts`,
        content: "ignored",
      });
      completeMutation(tracker, toolCallId, status);
    }
    expect(tracker.resolve()).toEqual({ files: 1, added: 3, removed: 2 });

    stageMutation(tracker, "patch-1", "apply_patch", {
      input: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        "-three",
        "+four",
        "+five",
        "*** Add File: src/new.ts",
        "+new",
        "+line",
        "*** End Patch",
      ].join("\n"),
    });
    completeMutation(tracker, "patch-1");
    expect(tracker.resolve()).toEqual({ files: 2, added: 7, removed: 3 });

    stageMutation(tracker, "codex-patch-1", "apply_patch", {
      changes: [
        { path: "src/example.ts", stat: { added: 7, removed: 3 } },
        { path: "src/third.ts", stat: { added: 5, removed: 2 } },
      ],
    });
    completeMutation(tracker, "codex-patch-1");
    expect(tracker.resolve()).toEqual({ files: 3, added: 19, removed: 8 });

    stageMutation(tracker, "pending-reset", "write", {
      path: "src/pending-reset.ts",
      content: "pending",
    });
    tracker.reset();
    expect(tracker.resolve()).toBeUndefined();
    completeMutation(tracker, "pending-reset");
    expect(tracker.resolve()).toBeUndefined();
  });

  it("bounds pending staging and distinct committed file tracking", () => {
    const tracker = createProgressDraftDiffStatTracker({ canStage: () => true });

    for (let index = 0; index < 65; index += 1) {
      stageMutation(tracker, `write-${index}`, "write", {
        path: `src/file-${index}.ts`,
        content: "line",
      });
    }
    expect(tracker.resolve()).toBeUndefined();
    for (let index = 0; index < 65; index += 1) {
      completeMutation(tracker, `write-${index}`);
    }
    expect(tracker.resolve()).toEqual({ files: 64, added: 64, removed: 0 });

    for (let index = 64; index < 257; index += 1) {
      const toolCallId = `restaged-write-${index}`;
      stageMutation(tracker, toolCallId, "write", {
        path: `src/file-${index}.ts`,
        content: "line",
      });
      completeMutation(tracker, toolCallId);
    }
    expect(tracker.resolve()).toEqual({ files: 257, added: 257, removed: 0 });

    stageMutation(tracker, "edit-known", "edit", {
      path: "src/file-0.ts",
      oldText: "one\ntwo",
      newText: "one\ntwo\nthree",
    });
    completeMutation(tracker, "edit-known");
    expect(tracker.resolve()).toEqual({ files: 257, added: 260, removed: 2 });
  });
});
