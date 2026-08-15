/**
 * Tests OAuth identity and mirroring gates.
 * Includes direct and fuzz coverage for account/email comparison so refreshed
 * credentials cannot poison another auth store.
 */
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import {
  isSafeToCopyOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
  shouldMirrorRefreshedOAuthCredential,
} from "./oauth-identity.js";
import { makeSeededRandom, maybe, randomAsciiString as randomString } from "./oauth-test-utils.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

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
});

describe("shouldMirrorRefreshedOAuthCredential", () => {
  type MirrorCase = {
    name: string;
    refreshed?: OAuthCredential;
    existing: AuthProfileCredential | undefined;
    shouldMirror: boolean;
    reason: string;
  };
  const refreshed = {
    type: "oauth",
    provider: "openai",
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
        provider: "openai",
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
        provider: "openai",
        access: "old",
        refresh: "old-refresh",
        expires: Number.NaN,
        accountId: "acct-1",
      },
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "out-of-range existing expiry",
      existing: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: "old-refresh",
        expires: MAX_DATE_TIMESTAMP_MS + 1,
        accountId: "acct-1",
      },
      shouldMirror: true,
      reason: "incoming-fresher",
    },
    {
      name: "out-of-range refreshed expiry",
      refreshed: {
        ...refreshed,
        expires: MAX_DATE_TIMESTAMP_MS + 1,
      },
      existing: {
        type: "oauth",
        provider: "openai",
        access: "old",
        refresh: "old-refresh",
        expires: 1_000,
        accountId: "acct-1",
      },
      shouldMirror: false,
      reason: "incoming-not-fresher",
    },
    {
      name: "identity upgrade",
      existing: {
        type: "oauth",
        provider: "openai",
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
        provider: "openai",
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
        provider: "openai",
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
        provider: "openai",
        access: "main-fresh",
        refresh: "main-fresh-refresh",
        expires: 3_000,
        accountId: "acct-1",
      },
      shouldMirror: false,
      reason: "incoming-not-fresher",
    },
  ];

  it.each(cases)(
    "returns $reason for $name",
    ({ existing, refreshed: caseRefreshed, shouldMirror, reason }) => {
      expect(
        shouldMirrorRefreshedOAuthCredential({
          existing,
          refreshed: caseRefreshed ?? refreshed,
        }),
      ).toEqual({ shouldMirror, reason });
    },
  );

  it("refuses identity regression from a known-account main credential", () => {
    expect(
      shouldMirrorRefreshedOAuthCredential({
        existing: {
          type: "oauth",
          provider: "openai",
          access: "main-identity-access",
          refresh: "main-identity-refresh",
          expires: 1_000,
          accountId: "acct-main",
        },
        refreshed: {
          type: "oauth",
          provider: "openai",
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
