import type { OAuthRefreshFailureReason } from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { MessagePresentation } from "../interactive/payload.js";

export type CodexLoginRecoveryEvidence = {
  provider?: string | null;
  oauthReason?: OAuthRefreshFailureReason | null;
  failoverReason?: FailoverReason;
  authMode?: string;
};

export type CodexLoginRecovery = {
  hint: string;
  presentation: MessagePresentation;
};

const AUTH_PROFILE_LOGIN_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

/** Builds login recovery only from OAuth evidence, never from a provider name alone. */
export function buildCodexLoginRecovery(
  evidence: CodexLoginRecoveryEvidence,
): CodexLoginRecovery | undefined {
  const provider = evidence.provider?.trim().toLowerCase().replace(/_/gu, "-");
  const needsLogin =
    evidence.oauthReason !== null && evidence.oauthReason !== undefined
      ? true
      : evidence.authMode === "oauth" &&
        evidence.failoverReason !== undefined &&
        AUTH_PROFILE_LOGIN_REASONS.has(evidence.failoverReason);
  if ((provider !== "openai" && provider !== "codex") || !needsLogin) {
    return undefined;
  }
  return {
    hint: "OpenAI needs a new login. Send `/login codex` from a private chat or Web UI session. Where shown, you can also select **Log in to Codex**.",
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Log in to Codex",
              action: { type: "command", command: "/login codex" },
            },
          ],
        },
      ],
    },
  };
}
