/**
 * Tests auth profile failure messages.
 * Verifies actionable recovery hints, transient-copy suppression, provider
 * naming, and diagnostic cause handling.
 */
import { describe, expect, it, vi } from "vitest";

const LOGIN_HINT_SENTINEL = "<<login-hint-for-provider>>";

vi.mock("../provider-auth-recovery-hint.js", () => ({
  buildProviderAuthRecoveryHint: (params: { provider: string }) =>
    `${LOGIN_HINT_SENTINEL}:${params.provider}`,
}));

import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import { formatAuthProfileFailureMessage } from "./failure-copy.js";

const PROVIDER = "openai-codex";

const REASONS_WITH_RECOVERY: readonly FailoverReason[] = [
  "auth",
  "session_expired",
  "auth_permanent",
  "billing",
];
const REASONS_WITHOUT_RECOVERY: readonly FailoverReason[] = [
  "rate_limit",
  "overloaded",
  "timeout",
  "server_error",
  "model_not_found",
  "format",
];

describe("formatAuthProfileFailureMessage", () => {
  describe("recovery-hint dispatch", () => {
    it("includes the login command for reasons the user can act on", () => {
      for (const reason of REASONS_WITH_RECOVERY) {
        const message = formatAuthProfileFailureMessage({
          reason,
          provider: PROVIDER,
          allInCooldown: true,
        });
        expect(message, `reason=${reason}`).toContain(`${LOGIN_HINT_SENTINEL}:${PROVIDER}`);
      }
    });

    it("omits the login command for transient cooldown reasons", () => {
      for (const reason of REASONS_WITHOUT_RECOVERY) {
        const message = formatAuthProfileFailureMessage({
          reason,
          provider: PROVIDER,
          allInCooldown: true,
        });
        expect(message, `reason=${reason}`).not.toContain(LOGIN_HINT_SENTINEL);
      }
    });
  });

  describe("reason coverage", () => {
    it("renders distinct copy across the major reason classes", () => {
      const samples = (["auth", "billing", "rate_limit", "timeout"] as const).map((reason) =>
        formatAuthProfileFailureMessage({ reason, provider: PROVIDER, allInCooldown: true }),
      );
      expect(new Set(samples).size).toBe(samples.length);
    });

    it("always mentions the provider name", () => {
      for (const reason of [
        ...REASONS_WITH_RECOVERY,
        ...REASONS_WITHOUT_RECOVERY,
        "unknown",
      ] as const) {
        const message = formatAuthProfileFailureMessage({
          reason,
          provider: PROVIDER,
          allInCooldown: true,
        });
        expect(message, `reason=${reason}`).toContain(PROVIDER);
      }
    });
  });

  describe("cause handling", () => {
    it("returns the cause text verbatim when the reason has no actionable copy", () => {
      const cause = new Error("upstream provider returned 502");
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: PROVIDER,
        allInCooldown: false,
        cause,
      });
      expect(message).toBe(cause.message);
    });

    it("appends a diagnostic suffix when the cause adds detail beyond the description", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: PROVIDER,
        allInCooldown: false,
        cause: new Error("invalid_grant"),
      });
      expect(message).toContain("(invalid_grant)");
    });

    it("does not append a diagnostic suffix when the cause text is already in the description", () => {
      // Derive the description sentence by formatting once without a cause, then stripping
      // the mocked recovery hint. Using that sentence as the cause should be deduped.
      const withoutCause = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: PROVIDER,
        allInCooldown: false,
      });
      const description = withoutCause
        .replace(new RegExp(`\\s*${LOGIN_HINT_SENTINEL}:[^\\s]+\\s*$`), "")
        .trim();
      const withDuplicateCause = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: PROVIDER,
        allInCooldown: false,
        cause: new Error(description),
      });
      expect(withDuplicateCause).toBe(withoutCause);
    });

    it("produces non-empty copy for unknown reasons with no cause", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: PROVIDER,
        allInCooldown: false,
      });
      expect(message).toContain(PROVIDER);
      expect(message.length).toBeGreaterThan(0);
    });
  });
});
