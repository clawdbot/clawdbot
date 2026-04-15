import { describe, expect, it } from "vitest";
import { normalizeMatrixAllowList, resolveMatrixAllowListMatch } from "./allowlist.js";

describe("resolveMatrixAllowListMatch", () => {
  it("matches full user IDs and prefixes", () => {
    const userId = "@Alice:Example.org";
    const direct = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["@alice:example.org"]),
      userId,
    });
    expect(direct.allowed).toBe(true);
    expect(direct.matchSource).toBe("id");

    const prefixedMatrix = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["matrix:@alice:example.org"]),
      userId,
    });
    expect(prefixedMatrix.allowed).toBe(true);
    expect(prefixedMatrix.matchSource).toBe("prefixed-id");

    const prefixedUser = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["user:@alice:example.org"]),
      userId,
    });
    expect(prefixedUser.allowed).toBe(true);
    expect(prefixedUser.matchSource).toBe("prefixed-user");
  });

  it("ignores display names and localparts", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["alice", "Alice"]),
      userId: "@alice:example.org",
    });
    expect(match.allowed).toBe(false);
  });

  it("matches wildcard", () => {
    const match = resolveMatrixAllowListMatch({
      allowList: normalizeMatrixAllowList(["*"]),
      userId: "@alice:example.org",
    });
    expect(match.allowed).toBe(true);
    expect(match.matchSource).toBe("wildcard");
  });
});
