import { describe, expect, it } from "vitest";
import { readActiveCodexTurnIdsFromResume } from "./thread-fingerprints.js";

describe("readActiveCodexTurnIdsFromResume", () => {
  it("uses the bounded initial turns page when Codex returns one", () => {
    expect(
      readActiveCodexTurnIdsFromResume({
        thread: { turns: [{ id: "stale", status: "inProgress" }] },
        initialTurnsPage: {
          data: [{ id: "current", status: "inProgress" }],
        },
      }),
    ).toEqual(["current"]);
  });

  it("falls back to legacy resume turns when no page is returned", () => {
    expect(
      readActiveCodexTurnIdsFromResume({
        thread: { turns: [{ id: "legacy", status: "inProgress" }] },
      }),
    ).toEqual(["legacy"]);
  });
});
