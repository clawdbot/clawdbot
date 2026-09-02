import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OAuthRefreshFailureReason } from "../agents/auth-profiles/oauth-refresh-failure.js";
import type { FailoverReason } from "../agents/failover/signal.js";
import type { MessagePresentation } from "../interactive/payload.js";
import {
  listProviderChannelLoginChoices,
  resolveProviderChannelLoginChoice,
  type ProviderChannelLoginResolution,
} from "../plugins/provider-login-options.js";

export type ProviderLoginRecoveryEvidence = {
  provider?: string | null;
  oauthReason?: OAuthRefreshFailureReason | null;
  failoverReason?: FailoverReason;
  authMode?: string;
};

export type ProviderLoginRecovery = {
  hint: string;
  presentation: MessagePresentation;
};

const AUTH_PROFILE_LOGIN_REASONS = new Set<FailoverReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

function resolveRecoveryLoginChoice(
  provider: string | null | undefined,
): ProviderChannelLoginResolution {
  // Recovery supplies a provider id, not an explicit auth choice. Prefer its one chat route
  // before an exact choice id such as "openai" can select a Control UI-only method.
  const providerId = normalizeLowercaseStringOrEmpty(provider);
  if (!providerId) {
    return { status: "unsupported", choices: [] };
  }
  const direct = listProviderChannelLoginChoices().filter(
    (choice) =>
      choice.mode === "chat" && normalizeLowercaseStringOrEmpty(choice.providerId) === providerId,
  );
  return direct.length === 1
    ? { status: "resolved", choice: direct[0]! }
    : resolveProviderChannelLoginChoice(provider ?? undefined);
}

/** Build an actionable login only from OAuth failure evidence and a trusted channel choice. */
export function buildProviderLoginRecovery(
  evidence: ProviderLoginRecoveryEvidence,
): ProviderLoginRecovery | undefined {
  const needsLogin =
    evidence.oauthReason !== null && evidence.oauthReason !== undefined
      ? true
      : evidence.authMode === "oauth" &&
        evidence.failoverReason !== undefined &&
        AUTH_PROFILE_LOGIN_REASONS.has(evidence.failoverReason);
  if (!needsLogin) {
    return undefined;
  }
  const resolution = resolveRecoveryLoginChoice(evidence.provider);
  if (resolution.status !== "resolved") {
    return undefined;
  }
  const { choice } = resolution;
  const command = `/login ${choice.command}`;
  const actionLabel = `Sign in to ${choice.providerLabel}`;
  return {
    hint: `${choice.providerLabel} needs a new login. Send \`${command}\` from a private chat or Control UI session. Where shown, you can also select **${actionLabel}**.`,
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: actionLabel,
              action: { type: "command", command },
            },
          ],
        },
      ],
    },
  };
}
