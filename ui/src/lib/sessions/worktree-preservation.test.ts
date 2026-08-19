import { describe, expect, it } from "vitest";
import type { WorktreePreservationReason } from "../../../../packages/gateway-protocol/src/index.js";
import {
  formatPreservedWorktreeConfirmation,
  formatPreservedWorktreesNotice,
} from "./worktree-preservation.ts";

describe("preserved session worktree presentation", () => {
  it.each([
    ["owner-mismatch", "registered to another owner"],
    ["busy", "still in use by a live run or another cleanup"],
    ["foreign-lock", "Git reports a lock owned outside OpenClaw"],
    ["snapshot-failed", "OpenClaw could not create a safety snapshot"],
    ["cleanup-failed", "cleanup did not finish normally"],
  ] satisfies Array<[WorktreePreservationReason, string]>)(
    "describes %s accurately",
    (reason, expected) => {
      expect(
        formatPreservedWorktreeConfirmation({
          id: "wt-reason",
          branch: "openclaw/reason",
          path: "/worktrees/reason",
          reason,
        }),
      ).toContain(`Reason: ${expected}.`);
    },
  );

  it("formats single and batch guidance with the preserved reasons", () => {
    const busy = {
      id: "wt-busy",
      branch: "openclaw/busy-task",
      path: "/worktrees/busy-task",
      reason: "busy" as const,
    };
    const snapshot = {
      id: "wt-snapshot",
      branch: "openclaw/snapshot-task",
      path: "/worktrees/snapshot-task",
      reason: "snapshot-failed" as const,
    };

    expect(formatPreservedWorktreeConfirmation(snapshot)).toBe(
      "The session worktree openclaw/snapshot-task needs attention. Reason: OpenClaw could not create a safety snapshot. Delete the checkout anyway?",
    );
    expect(formatPreservedWorktreesNotice([busy, snapshot])).toBe(
      "2 session worktree(s) need attention:\nopenclaw/busy-task — still in use by a live run or another cleanup\nopenclaw/snapshot-task — OpenClaw could not create a safety snapshot\nManage them under Settings -> Worktrees.",
    );
  });
});
