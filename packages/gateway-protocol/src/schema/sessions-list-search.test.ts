import { describe, expect, it } from "vitest";
import { validateSessionsListParams, validateSessionsSearchParams } from "../index.js";

describe("sessions.list schema", () => {
  it("accepts organization filters and rejects invalid filter values", () => {
    expect(
      validateSessionsListParams({
        category: null,
        ownerId: "agent-owner",
        unread: false,
        status: "queued",
        projectId: "openclaw",
        hasWorktree: false,
        needsAttention: false,
      }),
    ).toBe(true);
    expect(validateSessionsListParams({ status: "waiting" })).toBe(false);
  });
});

describe("sessions.search schema", () => {
  const search = (overrides: Record<string, unknown> = {}) => ({
    query: "deployment failure",
    ...overrides,
  });

  it("accepts bounded message and session result modes", () => {
    expect(validateSessionsSearchParams(search())).toBe(true);
    expect(
      validateSessionsSearchParams(
        search({
          agentId: "work",
          sessionKeys: ["agent:work:main", "agent:work:other"],
          limit: 25,
        }),
      ),
    ).toBe(true);
    expect(validateSessionsSearchParams(search({ resultMode: "sessions", limit: 100 }))).toBe(true);
  });

  it("rejects invalid scopes, bounds, and result modes", () => {
    const rejected = [
      search({ agentId: "" }),
      search({ sessionKey: "agent:work:main" }),
      search({ sessionKeys: [] }),
      search({ sessionKeys: Array.from({ length: 201 }, (_, index) => `session-${index}`) }),
      search({ limit: 101 }),
      search({ resultMode: "other" }),
      { query: "" },
      { query: "x".repeat(4097) },
    ];
    for (const params of rejected) {
      expect(validateSessionsSearchParams(params)).toBe(false);
    }
  });
});
