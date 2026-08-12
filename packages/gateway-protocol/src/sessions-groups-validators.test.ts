import { describe, expect, it } from "vitest";
import {
  validateSessionsGroupsListResult,
  validateSessionsGroupsMutationResult,
  validateSessionsGroupsUpdateParams,
} from "./index.js";

describe("session group result validators", () => {
  it("accepts legacy gateway payloads without sectionOrder", () => {
    expect(validateSessionsGroupsListResult({ groups: [] })).toBe(true);
    expect(validateSessionsGroupsMutationResult({ ok: true, groups: [] })).toBe(true);
  });

  it("accepts group defaults", () => {
    expect(
      validateSessionsGroupsListResult({
        groups: [{ name: "Client", position: 0, cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(validateSessionsGroupsUpdateParams({ name: "Client", cwd: null, worktree: false })).toBe(
      true,
    );
  });
});
