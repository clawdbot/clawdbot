// Centralizes user-facing failure copy for external agent runner errors.
import { AUTH_INVALID_TOKEN_USER_TEXT } from "../../agents/embedded-agent-helpers/error-text.js";

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";

export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.";

export const PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE =
  "⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.";

export const PROVIDER_RATE_LIMIT_OR_QUOTA_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned HTTP 429 before replying. This can mean rate limiting, exhausted quota, or an account balance/billing issue. Check the selected provider/model, API key, and provider billing/quota dashboard, then try again.";

export const PROVIDER_INTERNAL_ERROR_USER_MESSAGE =
  "⚠️ The model provider returned a temporary internal error before replying. Try again in a moment, or switch to another model if it keeps happening.";

export const PROVIDER_AUTHENTICATION_ERROR_USER_MESSAGE = `⚠️ ${AUTH_INVALID_TOKEN_USER_TEXT}`;

export const PROVIDER_MODEL_UNAVAILABLE_USER_MESSAGE =
  "⚠️ The configured model is unavailable from the provider — it may have been renamed, retired, or is not offered on this account. This needs a config update (agents.defaults.model); retrying or starting a new session won't fix it.";

const CONTROL_UI_LOG_HINT = "To view logs, run `openclaw logs --follow` in a terminal.";

/** Preserves raw errors on internal surfaces while making the log command actionable. */
export function buildControlUiAgentFailureText(errorText: string): string {
  const trimmedError = errorText.trim().replace(/\.\s*$/, "");
  return `⚠️ Agent failed before reply: ${trimmedError}.\n${CONTROL_UI_LOG_HINT}`;
}

/** True when text is exactly the generic external run failure copy. */
function isGenericExternalRunFailureText(text: string | undefined): boolean {
  return text?.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

/** Replaces trailing generic failure text with heartbeat-specific copy. */
export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  if (isGenericExternalRunFailureText(text)) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }

  const genericStart = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  if (genericStart < 0) {
    return { text, replaced: false };
  }

  const trailing = text.slice(genericStart + GENERIC_EXTERNAL_RUN_FAILURE_TEXT.length).trim();
  if (trailing) {
    return { text, replaced: false };
  }

  const prefix = text.slice(0, genericStart).trimEnd();
  return {
    text: prefix
      ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}`
      : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    replaced: true,
  };
}
