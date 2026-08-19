import { describe, expect, it } from "vitest";
import type { WorktreePreservationReason } from "../../../../packages/gateway-protocol/src/index.js";
import {
  formatPreservedWorktreeConfirmation,
  formatPreservedWorktreesNotice,
} from "./worktree-preservation.ts";

describe("preserved session worktree presentation", () => {
  it.each([
    ["owner-mismatch", "owned elsewhere"],
    ["busy", "live run or cleanup active"],
    ["foreign-lock", "foreign Git lock"],
    ["snapshot-failed", "OpenClaw could not create a safety snapshot"],
    ["cleanup-failed", "cleanup failed"],
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
      ).toContain(`— ${expected}.`);
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
      "Session needs attention: openclaw/snapshot-task — OpenClaw could not create a safety snapshot. Remove?",
    );
    expect(formatPreservedWorktreesNotice([busy, snapshot])).toBe(
      "Managed Worktrees:\nopenclaw/busy-task — live run or cleanup active\nopenclaw/snapshot-task — OpenClaw could not create a safety snapshot",
    );
  });
});
