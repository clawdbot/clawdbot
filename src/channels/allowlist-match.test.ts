// Allowlist match tests cover channel sender matching across static and pattern allowlists.
import { describe, expect, it } from "vitest";
import {
  resolveAllowlistMatchByCandidates,
  resolveAllowlistMatchSimple,
} from "./allowlist-match.js";

describe("channels/allowlist-match", () => {
  it("reflects in-place allowFrom edits even when array length stays the same", () => {
    const allowFrom = ["alice", "bob"];

    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "bob" })).toEqual({
      allowed: true,
      matchKey: "bob",
      matchSource: "id",
    });

    allowFrom[1] = "mallory";

    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "bob" })).toEqual({
      allowed: false,
    });
    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "mallory" })).toEqual({
      allowed: true,
      matchKey: "mallory",
      matchSource: "id",
    });
  });

  it("drops wildcard access after in-place wildcard replacement", () => {
    const allowFrom = ["*"];

    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "eve" })).toEqual({
      allowed: true,
      matchKey: "*",
      matchSource: "wildcard",
    });

    allowFrom[0] = "alice";

    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "eve" })).toEqual({
      allowed: false,
    });
    expect(resolveAllowlistMatchSimple({ allowFrom, senderId: "alice" })).toEqual({
      allowed: true,
      matchKey: "alice",
      matchSource: "id",
    });
  });

  it("recomputes candidate allowlist sets after in-place replacement", () => {
    const allowList = ["user:alice", "user:bob"];

    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "user:bob", source: "prefixed-user" }],
      }),
    ).toEqual({
      allowed: true,
      matchKey: "user:bob",
      matchSource: "prefixed-user",
    });

    allowList[1] = "user:mallory";

    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "user:bob", source: "prefixed-user" }],
      }),
    ).toEqual({
      allowed: false,
    });
    expect(
      resolveAllowlistMatchByCandidates({
        allowList,
        candidates: [{ value: "user:mallory", source: "prefixed-user" }],
      }),
    ).toEqual({
      allowed: true,
      matchKey: "user:mallory",
      matchSource: "prefixed-user",
    });
  });
});
