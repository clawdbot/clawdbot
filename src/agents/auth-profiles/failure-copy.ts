import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { FailoverReason } from "../embedded-agent-helpers/types.js";
import { buildProviderAuthRecoveryHint } from "../provider-auth-recovery-hint.js";

export type AuthProfileFailureCopyParams = {
  reason: FailoverReason;
  provider: string;
  /**
   * True when the failure was reached because every configured profile is in
   * cooldown / blocked. False when an attempt to use a specific profile threw
   * (e.g. credential lookup failed). The two paths produce different copy
   * because only the cooldown case implies "wait or rotate"; the other case
   * implies "the credential itself is broken".
   */
  allInCooldown: boolean;
  /**
   * Underlying error that triggered the failover, if any. Used to append a
   * short diagnostic suffix and to fall back to the original message when no
   * structured recovery copy applies.
   */
  cause?: unknown;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function describeReason(
  reason: FailoverReason,
  provider: string,
  allInCooldown: boolean,
): string | null {
  if (allInCooldown) {
    switch (reason) {
      case "auth":
      case "session_expired":
        return `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`;
      case "auth_permanent":
        return `${provider} isn't accepting your saved login anymore.`;
      case "billing":
        return `${provider} rejected the request — looks like a billing issue on the account.`;
      case "rate_limit":
        return `${provider} is asking us to slow down. Please wait a moment before trying again.`;
      case "overloaded":
        return `${provider} is overloaded right now. Please wait a moment before trying again.`;
      case "timeout":
        return `${provider} hasn't been responding. Please wait a moment before trying again.`;
      case "model_not_found":
        return `${provider} can't find the model you're using right now.`;
      case "server_error":
        return `${provider} is having issues right now. Please wait a moment before trying again.`;
      default:
        return `Couldn't reach ${provider} with any of your saved logins right now.`;
    }
  }
  switch (reason) {
    case "auth":
    case "session_expired":
      return `Couldn't sign in to ${provider}. Your saved login looks expired or no longer works.`;
    case "auth_permanent":
      return `${provider} isn't accepting your saved login.`;
    case "billing":
      return `${provider} rejected the request — looks like a billing issue on the account.`;
    default:
      return null;
  }
}

function shouldIncludeRecoveryHint(reason: FailoverReason): boolean {
  switch (reason) {
    case "auth":
    case "auth_permanent":
    case "session_expired":
    case "billing":
      return true;
    case "rate_limit":
    case "overloaded":
    case "timeout":
    case "server_error":
    case "model_not_found":
      return false;
    default:
      return true;
  }
}

function diagnosticSuffix(cause: unknown, primary: string): string | null {
  if (cause === undefined || cause === null) {
    return null;
  }
  const text = formatErrorMessage(cause).trim();
  if (!text || primary.includes(text)) {
    return null;
  }
  return ` (${text})`;
}

/**
 * Single source of truth for user-facing copy when an auth-profile rotation
 * fails. Composes a reason-specific sentence with an actionable next-step
 * derived from the provider's plugin manifest (`buildProviderAuthRecoveryHint`).
 *
 * Falls back to the underlying error's text when the reason maps to nothing
 * actionable, so we never produce worse copy than the raw error.
 */
export function formatAuthProfileFailureMessage(params: AuthProfileFailureCopyParams): string {
  const description = describeReason(params.reason, params.provider, params.allInCooldown);
  if (!description) {
    const causeText = params.cause ? formatErrorMessage(params.cause).trim() : "";
    if (causeText) {
      return causeText;
    }
    return `Couldn't reach ${params.provider} with any of your saved logins right now.`;
  }
  const hint = shouldIncludeRecoveryHint(params.reason)
    ? buildProviderAuthRecoveryHint({
        provider: params.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      })
    : null;
  const suffix = diagnosticSuffix(params.cause, description);
  const parts = [description];
  if (hint) {
    parts.push(hint);
  }
  const message = parts.join(" ");
  return suffix ? `${message}${suffix}` : message;
}
