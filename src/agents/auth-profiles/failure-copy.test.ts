/**
 * Tests auth profile failure messages.
 * Verifies actionable recovery hints, transient-copy suppression, provider
 * naming, and diagnostic cause handling.
 */
import { describe, expect, it } from "vitest";

const LOGIN_HINT_SENTINEL = "<<login-hint-for-provider>>";

import { FAILOVER_REASONS, type FailoverReason } from "../failover/signal.js";
import { renderAuthProfileFailoverCopy } from "../failover/user-copy.js";

const formatAuthProfileFailureMessage = (
  params: Parameters<typeof renderAuthProfileFailoverCopy>[0],
) =>
  renderAuthProfileFailoverCopy({
    ...params,
    recoveryHint: `${LOGIN_HINT_SENTINEL}:${params.provider}`,
  });

const PROVIDER = "openai-codex";

const RECOVERY_BY_REASON = {
  auth: true,
  auth_permanent: true,
  format: false,
  rate_limit: false,
  overloaded: false,
  billing: true,
  server_error: false,
  timeout: false,
  tls_certificate: false,
  context_overflow: true,
  model_not_found: false,
  session_expired: true,
  empty_response: true,
  no_error_details: true,
  unclassified: true,
  unknown: true,
} satisfies Record<FailoverReason, boolean>;

describe("renderAuthProfileFailoverCopy", () => {
  describe("recovery-hint dispatch", () => {
    it("dispatches the login command for every failover reason", () => {
      for (const reason of FAILOVER_REASONS) {
        const message = formatAuthProfileFailureMessage({
          reason,
          provider: PROVIDER,
          allInCooldown: true,
        });
        expect(message.includes(LOGIN_HINT_SENTINEL), `reason=${reason}`).toBe(
          RECOVERY_BY_REASON[reason],
        );
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
      for (const reason of FAILOVER_REASONS) {
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
      const causeText = "upstream provider returned 502";
      const message = formatAuthProfileFailureMessage({
        reason: "unknown",
        provider: PROVIDER,
        allInCooldown: false,
        causeText,
      });
      expect(message).toBe(causeText);
    });

    it("appends a diagnostic suffix when the cause adds detail beyond the description", () => {
      const message = formatAuthProfileFailureMessage({
        reason: "auth",
        provider: PROVIDER,
        allInCooldown: false,
        causeText: "invalid_grant",
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
        causeText: description,
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
