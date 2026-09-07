import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsDeleteResultSchema } from "./sessions-delete.js";

describe("SessionsDeleteResultSchema", () => {
  it("rejects unknown and missing worktree preservation reasons", () => {
    const preserved = {
      id: "wt-1",
      branch: "openclaw/task-one",
      path: "/worktree/task-one",
    };
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
