import { describe, expect, it } from "vitest";
import {
  isSafeToCopyOAuthIdentity,
  isSameOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
import { makeSeededRandom, maybe, randomAsciiString as randomString } from "./oauth-test-utils.js";
import type { AuthProfileCredential } from "./types.js";

// Direct unit + fuzz tests for the cross-agent credential-mirroring identity
// gate introduced for #26322 (CWE-284). These helpers are on the hot-path of
// `mirrorRefreshedCredentialIntoMainStore` and must be strictly correct: a
// false positive means a sub-agent could poison the main-agent auth store.

describe("normalizeAuthIdentityToken", () => {
  it("returns trimmed value when non-empty", () => {
    expect(normalizeAuthIdentityToken("acct-123")).toBe("acct-123");
    expect(normalizeAuthIdentityToken("  acct-123  ")).toBe("acct-123");
  });

  it("returns undefined for undefined, empty, or whitespace-only input", () => {
    expect(normalizeAuthIdentityToken(undefined)).toBeUndefined();
    expect(normalizeAuthIdentityToken("")).toBeUndefined();
    expect(normalizeAuthIdentityToken("   ")).toBeUndefined();
    expect(normalizeAuthIdentityToken("\t\n\r")).toBeUndefined();
  });

  it("preserves case (accountIds are case-sensitive)", () => {
    expect(normalizeAuthIdentityToken("Acct-ABC")).toBe("Acct-ABC");
    expect(normalizeAuthIdentityToken("acct-abc")).toBe("acct-abc");
  });
});

describe("normalizeAuthEmailToken", () => {
  it("lowercases and trims email", () => {
    expect(normalizeAuthEmailToken("USER@Example.COM")).toBe("user@example.com");
    expect(normalizeAuthEmailToken("  user@example.com  ")).toBe("user@example.com");
  });

  it("returns undefined for undefined/empty/whitespace", () => {
    expect(normalizeAuthEmailToken(undefined)).toBeUndefined();
    expect(normalizeAuthEmailToken("")).toBeUndefined();
    expect(normalizeAuthEmailToken("   ")).toBeUndefined();
  });

  it("preserves internal plus-addressing and unicode", () => {
    expect(normalizeAuthEmailToken("User+Tag@Example.com")).toBe("user+tag@example.com");
    expect(normalizeAuthEmailToken("  JOSÉ@Example.com ")).toBe("josé@example.com");
  });
});

describe("isSameOAuthIdentity", () => {
  describe("accountId takes priority when present on both sides", () => {
    it("returns true when accountIds match", () => {
      expect(isSameOAuthIdentity({ accountId: "acct-1" }, { accountId: "acct-1" })).toBe(true);
    });

    it("returns true for accountId match even if emails differ", () => {
      expect(
        isSameOAuthIdentity(
          { accountId: "acct-1", email: "a@example.com" },
          { accountId: "acct-1", email: "b@example.com" },
        ),
      ).toBe(true);
    });

    it("returns false when accountIds mismatch, ignoring email", () => {
      expect(
        isSameOAuthIdentity(
          { accountId: "acct-1", email: "same@example.com" },
          { accountId: "acct-2", email: "same@example.com" },
        ),
      ).toBe(false);
    });

    it("treats whitespace-equal accountIds as same", () => {
      expect(isSameOAuthIdentity({ accountId: "  acct-1  " }, { accountId: "acct-1" })).toBe(true);
    });

    it("treats accountId comparisons as case-sensitive", () => {
      expect(isSameOAuthIdentity({ accountId: "Acct-1" }, { accountId: "acct-1" })).toBe(false);
    });
  });

  describe("email fallback when accountId missing on either side", () => {
    it("returns true when emails match (case-insensitive)", () => {
      expect(
        isSameOAuthIdentity({ email: "user@example.com" }, { email: "USER@Example.COM" }),
      ).toBe(true);
    });

    it("returns false when emails mismatch", () => {
      expect(isSameOAuthIdentity({ email: "a@example.com" }, { email: "b@example.com" })).toBe(
        false,
      );
    });

    it("matches when main has accountId+email and incoming has only matching email", () => {
      // Not asymmetric: both sides carry identity (main has more, but
      // incoming still has email). Email is a shared field with a
      // matching value — positive-identity match, safe to mirror.
      expect(
        isSameOAuthIdentity(
          { accountId: "acct-1", email: "user@example.com" },
          { email: "user@example.com" },
        ),
      ).toBe(true);
    });

    it("matches when accountIds on one side are whitespace-only and both sides expose matching email", () => {
      // Whitespace-only accountId is treated as absent; email falls back
      // symmetrically on both sides so the positive email match wins.
      expect(
        isSameOAuthIdentity(
          { accountId: "   ", email: "user@example.com" },
          { accountId: "", email: "USER@example.com" },
        ),
      ).toBe(true);
    });
  });

  describe("asymmetric identity evidence is refused", () => {
    it("refuses when main has accountId and incoming has neither", () => {
      expect(isSameOAuthIdentity({ accountId: "acct-1" }, {})).toBe(false);
    });

    it("refuses when main has email and incoming has neither", () => {
      expect(isSameOAuthIdentity({ email: "user@example.com" }, {})).toBe(false);
    });

    it("refuses when incoming has identity but main does not", () => {
      expect(isSameOAuthIdentity({}, { accountId: "acct-1" })).toBe(false);
      expect(isSameOAuthIdentity({}, { email: "user@example.com" })).toBe(false);
    });

    it("refuses when main has only accountId and incoming has only email (non-overlapping fields)", () => {
      expect(isSameOAuthIdentity({ accountId: "acct-1" }, { email: "user@example.com" })).toBe(
        false,
      );
    });
  });

  describe("no identity metadata on either side", () => {
    it("returns true (no evidence of mismatch) when both sides lack accountId and email", () => {
      // This matches the looser behaviour of the pre-existing
      // adoptNewerMainOAuthCredential gate; provider equality is the
      // caller's responsibility.
      expect(isSameOAuthIdentity({}, {})).toBe(true);
    });

    it("returns true when one side has empty strings for both fields", () => {
      expect(
        isSameOAuthIdentity(
          { accountId: "", email: "" },
          { accountId: undefined, email: undefined },
        ),
      ).toBe(true);
    });
  });

  describe("reflexivity and symmetry", () => {
    it("is reflexive: share(a,a) === true for any non-conflicting identity", () => {
      const a = { accountId: "acct-1", email: "a@example.com" };
      expect(isSameOAuthIdentity(a, a)).toBe(true);
    });

    it("is symmetric: share(a,b) === share(b,a)", () => {
      const a = { accountId: "acct-1" };
      const b = { accountId: "acct-2" };
      expect(isSameOAuthIdentity(a, b)).toBe(isSameOAuthIdentity(b, a));
    });
  });
});

// ---------------------------------------------------------------------------
// Fuzz tests. Seeded Mulberry32 so the run is reproducible.
// ---------------------------------------------------------------------------

describe("isSafeToCopyOAuthIdentity (unified copy gate, used for mirror and adopt)", () => {
  describe("positive matches", () => {
    it("accepts matching accountIds", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, { accountId: "x" })).toBe(true);
    });

    it("accepts matching emails (case-insensitive)", () => {
      expect(
        isSafeToCopyOAuthIdentity({ email: "u@example.com" }, { email: "U@Example.com" }),
      ).toBe(true);
    });

    it("accepts when both sides expose identical identity across accountId + email", () => {
      expect(
        isSafeToCopyOAuthIdentity(
          { accountId: "x", email: "u@example.com" },
          { accountId: "x", email: "u@example.com" },
        ),
      ).toBe(true);
    });
  });

  describe("upgrade tolerance (primary motivator)", () => {
    it("accepts existing-no-identity adopting incoming-with-accountId", () => {
      // The #26322 upgrade case: existing cred predates accountId capture,
      // incoming has it. Must allow or the fix regresses on existing installs.
      expect(isSafeToCopyOAuthIdentity({}, { accountId: "x" })).toBe(true);
    });

    it("accepts existing-no-identity adopting incoming-with-email", () => {
      expect(isSafeToCopyOAuthIdentity({}, { email: "u@example.com" })).toBe(true);
    });

    it("accepts when both sides lack identity metadata", () => {
      expect(isSafeToCopyOAuthIdentity({}, {})).toBe(true);
    });
  });

  describe("identity regression is refused (incoming drops existing's identity)", () => {
    it("refuses when incoming has no identity and existing has accountId", () => {
      // Was previously allowed under the permissive relaxed rule; the
      // narrower rule refuses because it would strip identity evidence.
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, {})).toBe(false);
    });

    it("refuses when incoming has no identity and existing has email", () => {
      expect(isSafeToCopyOAuthIdentity({ email: "u@example.com" }, {})).toBe(false);
    });
  });

  describe("non-overlapping identity fields are refused", () => {
    it("refuses when existing has only accountId and incoming has only email", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, { email: "u@example.com" })).toBe(false);
    });

    it("refuses when existing has only email and incoming has only accountId", () => {
      expect(isSafeToCopyOAuthIdentity({ email: "u@example.com" }, { accountId: "x" })).toBe(false);
    });
  });

  describe("positive mismatch still refuses (CWE-284 protection)", () => {
    it("refuses mismatching accountIds even when emails match", () => {
      expect(
        isSafeToCopyOAuthIdentity(
          { accountId: "a", email: "u@example.com" },
          { accountId: "b", email: "u@example.com" },
        ),
      ).toBe(false);
    });

    it("refuses mismatching emails when both sides expose only email", () => {
      expect(
        isSafeToCopyOAuthIdentity({ email: "a@example.com" }, { email: "b@example.com" }),
      ).toBe(false);
    });

    it("keeps accountId case-sensitive in the copy gate", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "X" }, { accountId: "x" })).toBe(false);
    });
  });

  describe("normalization", () => {
    it("ignores surrounding whitespace on accountId", () => {
      expect(isSafeToCopyOAuthIdentity({ accountId: "  acct-1  " }, { accountId: "acct-1" })).toBe(
        true,
      );
    });

    it("ignores email case and whitespace", () => {
      expect(
        isSafeToCopyOAuthIdentity({ email: "  U@Example.com  " }, { email: "u@example.com" }),
      ).toBe(true);
    });

    it("treats empty/whitespace-only identity as absent (allowed to upgrade)", () => {
      expect(
        isSafeToCopyOAuthIdentity({ accountId: "   ", email: "" }, { accountId: "acct-main" }),
      ).toBe(true);
    });
  });

  describe("reflexivity", () => {
    it("is reflexive", () => {
      const a = { accountId: "acct-1", email: "u@example.com" };
      expect(isSafeToCopyOAuthIdentity(a, a)).toBe(true);
    });
  });

  describe("relationship to the strict isSameOAuthIdentity reference", () => {
    it("is at least as permissive as the strict rule (strict implies safe-to-copy)", () => {
      // Pure-symmetric match cases accepted by the strict rule must also
      // be accepted by the unified copy gate.
      expect(isSameOAuthIdentity({ accountId: "x" }, { accountId: "x" })).toBe(true);
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, { accountId: "x" })).toBe(true);
    });

    it("only relaxes the strict rule in the pure-upgrade direction", () => {
      // Existing has no identity, incoming has identity: strict refuses,
      // unified accepts.
      expect(isSameOAuthIdentity({}, { accountId: "x" })).toBe(false);
      expect(isSafeToCopyOAuthIdentity({}, { accountId: "x" })).toBe(true);
    });

    it("does NOT relax in the regression direction (strict and unified both refuse)", () => {
      expect(isSameOAuthIdentity({ accountId: "x" }, {})).toBe(false);
      expect(isSafeToCopyOAuthIdentity({ accountId: "x" }, {})).toBe(false);
    });
  });
});

describe("shouldMirrorRefreshedOAuthCredential", () => {
  type MirrorCase = {
    name: string;
    existing: AuthProfileCredential | undefined;
    shouldMirror: boolean;
    reason: string;
  };
  const refreshed = {
    type: "oauth",
    provider: "openai-codex",
    access: "fresh-access",
    refresh: "fresh-refresh",
    expires: 2_000,
    accountId: "acct-1",
  } as const;

  const cases: MirrorCase[] = [
    {
      name: "empty main store",
      existing: undefined,
      shouldMirror: true,
      reason: "no-existing-credential",
    },
    {
      name: "matching older oauth credential",
      existing: {
        type: "oauth",
        provider: "openai-codex",
        access: "old",
        refresh: "old-refresh",
        expires: 1_000,
        accountId: "acct-1",
      },
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "non-finite existing expiry",
      existing: {
        type: "oauth",
        provider: "openai-codex",
        access: "old",
        refresh: "old-refresh",
        expires: Number.NaN,
        accountId: "acct-1",
      },
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "identity upgrade",
      existing: {
        type: "oauth",
        provider: "openai-codex",
        access: "old",
        refresh: "old-refresh",
        expires: 1_000,
      },
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "api key override",
      existing: {
        type: "api_key",
        provider: "openai-codex",
        key: "operator-key",
      },
      shouldMirror: false,
      reason: "non-oauth-existing-credential",
    },
    {
      name: "provider mismatch",
      existing: {
        type: "oauth",
        provider: "anthropic",
        access: "old",
        refresh: "old-refresh",
        expires: 1_000,
        accountId: "acct-1",
      },
      shouldMirror: false,
      reason: "provider-mismatch",
    },
    {
      name: "identity mismatch",
      existing: {
        type: "oauth",
        provider: "openai-codex",
        access: "old",
        refresh: "old-refresh",
        expires: 1_000,
        accountId: "acct-2",
      },
      shouldMirror: false,
      reason: "identity-mismatch-or-regression",
    },
    {
      name: "strictly fresher existing credential",
      existing: {
        type: "oauth",
        provider: "openai-codex",
        access: "main-fresh",
        refresh: "main-fresh-refresh",
        expires: 3_000,
        accountId: "acct-1",
      },
      shouldMirror: false,
      reason: "incoming-not-fresher",
    },
  ];

  it.each(cases)("returns $reason for $name", ({ existing, shouldMirror, reason }) => {
    expect(
      shouldMirrorRefreshedOAuthCredential({
        existing,
        refreshed,
      }),
    ).toEqual({ shouldMirror, reason });
  });

  it("refuses identity regression from a known-account main credential", () => {
    expect(
      shouldMirrorRefreshedOAuthCredential({
        existing: {
          type: "oauth",
          provider: "openai-codex",
          access: "main-identity-access",
          refresh: "main-identity-refresh",
          expires: 1_000,
          accountId: "acct-main",
        },
        refreshed: {
          type: "oauth",
          provider: "openai-codex",
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: 2_000,
        },
      }),
    ).toEqual({
      shouldMirror: false,
      reason: "identity-mismatch-or-regression",
    });
  });
});

describe("isSafeToCopyOAuthIdentity fuzz", () => {
  it("is reflexive: share(a, a) is always true", () => {
    const rng = makeSeededRandom(0x0172_0417);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isSafeToCopyOAuthIdentity(a, a)).toBe(true);
    }
  });

  it("always refuses distinct non-empty accountIds (primary CWE-284 invariant)", () => {
    const rng = makeSeededRandom(0xfaceb00c);
    for (let i = 0; i < 500; i += 1) {
      const idA = `A-${randomString(rng, 32) || "x"}`;
      const idB = `B-${randomString(rng, 32) || "y"}`;
      expect(isSafeToCopyOAuthIdentity({ accountId: idA }, { accountId: idB })).toBe(false);
    }
  });

  it("strict → unified: if isSameOAuthIdentity accepts, isSafeToCopyOAuthIdentity accepts", () => {
    // Monotonic relaxation property over random inputs.
    const rng = makeSeededRandom(0x7777_7777);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 32)),
        email: maybe(rng, randomString(rng, 32)),
      };
      const b = {
        accountId: maybe(rng, randomString(rng, 32)),
        email: maybe(rng, randomString(rng, 32)),
      };
      if (isSameOAuthIdentity(a, b)) {
        expect(isSafeToCopyOAuthIdentity(a, b)).toBe(true);
      }
    }
  });

  it("unified rule never refuses a same-account pair and never accepts a different-account pair", () => {
    // Over random identity pairs that share accountId but vary in every
    // other field, the gate must always accept. Over pairs with distinct
    // non-empty accountIds it must always refuse.
    const rng = makeSeededRandom(0x9a_9b_9c_9d);
    for (let i = 0; i < 500; i += 1) {
      const shared = `acct-${randomString(rng, 32) || "x"}`;
      const a = {
        accountId: shared,
        email: maybe(rng, randomString(rng, 32)),
      };
      const b = {
        accountId: shared,
        email: maybe(rng, randomString(rng, 32)),
      };
      expect(isSafeToCopyOAuthIdentity(a, b)).toBe(true);
    }
  });
});

describe("isSameOAuthIdentity fuzz", () => {
  it("is always symmetric regardless of input shape", () => {
    const rng = makeSeededRandom(0x0426_0417);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      const b = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isSameOAuthIdentity(a, b)).toBe(isSameOAuthIdentity(b, a));
    }
  });

  it("is always reflexive: share(a, a) is true", () => {
    const rng = makeSeededRandom(0x1234_abcd);
    for (let i = 0; i < 1000; i += 1) {
      const a = {
        accountId: maybe(rng, randomString(rng, 64)),
        email: maybe(rng, randomString(rng, 64)),
      };
      expect(isSameOAuthIdentity(a, a)).toBe(true);
    }
  });

  it("never returns true for distinct non-empty accountIds (regardless of email)", () => {
    const rng = makeSeededRandom(0xfeedc0de);
    for (let i = 0; i < 500; i += 1) {
      const idA = `A-${randomString(rng, 32) || "x"}`;
      const idB = `B-${randomString(rng, 32) || "y"}`;
      // Shared email; mismatched accountId must still refuse.
      const email = `${randomString(rng, 16) || "u"}@example.com`;
      expect(isSameOAuthIdentity({ accountId: idA, email }, { accountId: idB, email })).toBe(false);
    }
  });

  it("email comparison is case-insensitive for random email bodies", () => {
    const rng = makeSeededRandom(0xcafef00d);
    for (let i = 0; i < 500; i += 1) {
      const local = randomString(rng, 16).replace(/[^A-Za-z0-9+._-]/g, "") || "user";
      const domain = (randomString(rng, 12).replace(/[^A-Za-z0-9.-]/g, "") || "example") + ".com";
      const email = `${local}@${domain}`;
      const randomizedCase = email
        .split("")
        .map((c) => (rng() < 0.5 ? c.toUpperCase() : c.toLowerCase()))
        .join("");
      expect(isSameOAuthIdentity({ email }, { email: randomizedCase })).toBe(true);
    }
  });
});
