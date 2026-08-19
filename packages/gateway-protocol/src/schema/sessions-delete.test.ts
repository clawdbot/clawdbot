import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsDeleteResultSchema, WORKTREE_PRESERVATION_REASONS } from "./sessions-delete.js";

describe("SessionsDeleteResultSchema", () => {
  it("bounds preserved worktree cleanup reasons", () => {
    const preserved = {
      id: "wt-1",
      branch: "openclaw/task-one",
      path: "/worktree/task-one",
    };
    for (const reason of WORKTREE_PRESERVATION_REASONS) {
      expect(
        Value.Check(SessionsDeleteResultSchema, {
          ok: true,
          key: "agent:main:dashboard:task-one",
          deleted: true,
          archived: [],
          worktreePreserved: { ...preserved, reason },
        }),
      ).toBe(true);
    }
    expect(
      Value.Check(SessionsDeleteResultSchema, {
        ok: true,
        key: "agent:main:dashboard:task-one",
        deleted: true,
        archived: [],
        worktreePreserved: { ...preserved, reason: "dirty" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionsDeleteResultSchema, {
        ok: true,
        key: "agent:main:dashboard:task-one",
        deleted: true,
        archived: [],
        worktreePreserved: preserved,
      }),
    ).toBe(false);
  });
});
