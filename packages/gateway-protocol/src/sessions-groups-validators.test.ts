import { describe, expect, it } from "vitest";
import { validateSessionsGroupsListResult, validateSessionsGroupsMutationResult } from "./index.js";

describe("session group result validators", () => {
  it("accepts legacy gateway payloads without sectionOrder", () => {
    expect(validateSessionsGroupsListResult({ groups: [] })).toBe(true);
    expect(validateSessionsGroupsMutationResult({ ok: true, groups: [] })).toBe(true);
  });
});
