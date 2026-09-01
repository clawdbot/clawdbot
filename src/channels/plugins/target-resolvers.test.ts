// Target resolver tests cover channel plugin target resolution from user input and bindings.
import { describe, expect, it } from "vitest";
import {
  buildUnresolvedTargetResults,
  resolveTargetsWithOptionalToken,
} from "./target-resolvers.js";

describe("buildUnresolvedTargetResults", () => {
  it("marks each input unresolved with the same note", () => {
    expect(buildUnresolvedTargetResults(["a", "b"], "missing token")).toEqual([
      { input: "a", resolved: false, note: "missing token" },
      { input: "b", resolved: false, note: "missing token" },
    ]);
  });
});

describe("resolveTargetsWithOptionalToken", () => {
  it("returns unresolved entries when the token is missing", async () => {
    const resolved = await resolveTargetsWithOptionalToken({
      inputs: ["alice"],
      missingTokenNote: "missing token",
      resolveWithToken: async () => [{ input: "alice", id: "1" }],
      mapResolved: (entry) => ({ input: entry.input, resolved: true, id: entry.id }),
    });

    expect(resolved).toEqual([{ input: "alice", resolved: false, note: "missing token" }]);
  });

  it("resolves and maps entries when a token is present", async () => {
    const resolved = await resolveTargetsWithOptionalToken({
      token: " x ",
      inputs: ["alice"],
      missingTokenNote: "missing token",
      resolveWithToken: async ({ token, inputs }) =>
        inputs.map((input) => ({ input, id: `${token}:${input}` })),
      mapResolved: (entry) => ({ input: entry.input, resolved: true, id: entry.id }),
    });

    expect(resolved).toEqual([{ input: "alice", resolved: true, id: "x:alice" }]);
  });
});
