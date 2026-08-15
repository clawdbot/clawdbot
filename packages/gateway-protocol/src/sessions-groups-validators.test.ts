import { describe, expect, it } from "vitest";
import {
  validateSessionsGroupsDefaultsResult,
  validateSessionsGroupsListResult,
  validateSessionsGroupsMutationResult,
  validateSessionsGroupsUpdateParams,
  validateSessionsGroupsUpdateResult,
} from "./index.js";

describe("session group result validators", () => {
  it("accepts legacy gateway payloads without sectionOrder", () => {
    expect(validateSessionsGroupsListResult({ groups: [] })).toBe(true);
    expect(validateSessionsGroupsMutationResult({ ok: true, groups: [] })).toBe(true);
  });

  it("accepts group defaults", () => {
    expect(validateSessionsGroupsListResult({ groups: [{ name: "Client", position: 0 }] })).toBe(
      true,
    );
    expect(
      validateSessionsGroupsListResult({
        groups: [{ name: "Client", position: 0, cwd: "/repos/client" }],
      }),
    ).toBe(false);
    expect(
      validateSessionsGroupsDefaultsResult({
        defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(
      validateSessionsGroupsUpdateResult({
        ok: true,
        defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(validateSessionsGroupsUpdateParams({ name: "Client", cwd: null, worktree: false })).toBe(
      true,
    );
  });
});
