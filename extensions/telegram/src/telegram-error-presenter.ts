import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

/**
 * Maps an error to a safe, user-visible Telegram fallback message.
 *
 * Unlike the generic "Something went wrong", this presenter classifies
 * known error categories (rate limit, timeout, server error, etc.) and
 * returns actionable text without leaking operational diagnostics.
 * Unknown errors fall back to the generic message.
 */
export function formatTelegramFallbackError(err: unknown): string {
  const detail = formatErrorMessage(err).trim();
  if (!detail) {
    return "Something went wrong while processing your request. Please try again.";
  }

  // Order matters: more specific patterns first

  // Context overflow
  if (
    /context(?:\s+window)?\s+(?:overflow|exceed|too\s+long)|prompt\s+is\s+too\s+long/i.test(detail)
  ) {
    return "⚠️ Context overflow: prompt too large for the model. Use /new to start a fresh session.";
  }

  // Rate limit (before server error — 429 is specific)
  if (/\b429\b|rate\s+limit|too\s+many\s+requests|throttl/i.test(detail)) {
    return "⚠️ Rate limit reached. Please wait a moment and try again.";
  }

  // Overloaded (before generic server error)
  if (/\b529\b|overloaded/i.test(detail)) {
    return "⚠️ Provider is overloaded. Please try again in a moment.";
  }

  // Auth
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid\s+(?:api[_\s-]?key|token|credential)/i.test(
      detail,
    )
  ) {
    return "⚠️ Authentication failed. Check your provider configuration.";
  }

  // Billing
  if (
    /\b402\b|insufficient\s+(?:credits|quota|balance)|billing|spend\s+limit|usage\s+limit/i.test(
      detail,
    )
  ) {
    return "⚠️ Billing issue: insufficient credits or quota. Check your provider account.";
  }

  // Model not found — only when the provider explicitly says so.
  // A bare 404 can also mean a missing endpoint, deployment route, or base URL,
  // so it must not trigger model-specific recovery advice.
  if (/model\s+not\s+found|no\s+such\s+model/i.test(detail)) {
    return "⚠️ The selected model was not found. Try a different model.";
  }

  // Server errors (before timeout — "bad gateway" contains "gateway")
  if (
    /\b500\b|\b502\b|\b503\b|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|server\s+error|upstream\s+error/i.test(
      detail,
    )
  ) {
    return "⚠️ Provider server error. Please try again in a moment.";
  }

  // Timeout
  if (/\b408\b|\b504\b|timed?\s+out|timeout|etimedout|esockettimedout/i.test(detail)) {
    return "⚠️ Request timed out. Please try again.";
  }

  // Unknown — generic, no detail leakage
  return "Something went wrong while processing your request. Please try again.";
}
