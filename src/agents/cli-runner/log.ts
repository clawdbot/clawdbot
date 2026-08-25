/**
 * Shared logging helpers for CLI backend diagnostics.
 */
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CliSubscriptionRateLimit } from "../cli-output-contracts.js";

/** Subsystem logger for CLI backend execution diagnostics. */
export const cliBackendLog = createSubsystemLogger("agent/cli-backend");
/** Env var that enables CLI backend output logging. */
export const CLI_BACKEND_LOG_OUTPUT_ENV = "OPENCLAW_CLI_BACKEND_LOG_OUTPUT";
/** Legacy env var accepted for Claude CLI output logging. */
export const LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV = "OPENCLAW_CLAUDE_CLI_LOG_OUTPUT";

/** Return a compact byte/hash summary for CLI backend output. */
export function formatCliBackendOutputDigest(text: string): string {
  const outBytes = Buffer.byteLength(text, "utf8");
  const outHash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `outBytes=${outBytes} outHash=${outHash}`;
}

function formatRateLimitResetTime(resetsAt: number): string {
  return `${new Date(resetsAt * 1000).toISOString().slice(0, 16)}Z`;
}

export function formatCliSubscriptionRateLimitDigest(rateLimit: CliSubscriptionRateLimit): string {
  const parts = [`rateLimit=${rateLimit.status}`];
  for (const [name, window] of Object.entries(rateLimit.windows)) {
    const reset =
      name === rateLimit.rateLimitType ? `→${formatRateLimitResetTime(window.resetsAt)}` : "";
    parts.push(`${name}=${Math.round(window.utilization * 100)}%${reset}`);
  }
  if (rateLimit.overageStatus) {
    parts.push(
      `overage=${rateLimit.overageStatus}${rateLimit.overageDisabledReason ? `(${rateLimit.overageDisabledReason})` : ""}`,
    );
  }
  if (rateLimit.errorCode) {
    parts.push(`error=${rateLimit.errorCode}`);
  }
  if (rateLimit.isUsingOverage) {
    parts.push("usingOverage");
  }
  return parts.join(" ");
}
