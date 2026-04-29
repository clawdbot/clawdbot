/**
 * Security module: token validation, rate limiting, input sanitization, user allowlist.
 */

import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import {
  createFixedWindowRateLimiter,
  type FixedWindowRateLimiter,
} from "openclaw/plugin-sdk/webhook-ingress";

export type DmAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "allowlist-empty" | "not-allowlisted" };

/**
 * Validate webhook token using constant-time comparison.
 * Reject empty tokens explicitly; use shared constant-time comparison otherwise.
 */
export function validateToken(received: string, expected: string): boolean {
  if (!received || !expected) {
    return false;
  }
  return safeEqualSecret(received, expected);
}

/**
 * Check if a user ID is in the allowed list.
 * Allowlist mode must be explicit; empty lists should not match any user.
 */
export function checkUserAllowed(userId: string, allowedUserIds: string[]): boolean {
  if (allowedUserIds.length === 0) {
    return false;
  }
  if (allowedUserIds.includes("*")) {
    return true;
  }
  return allowedUserIds.includes(userId);
}

/**
 * Resolve DM authorization for a sender across all DM policy modes.
 * Keeps policy semantics in one place so webhook/startup behavior stays consistent.
 */
export function authorizeUserForDm(
  userId: string,
  dmPolicy: "open" | "allowlist" | "disabled",
  allowedUserIds: string[],
): DmAuthorizationResult {
  if (dmPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (dmPolicy === "open") {
    return checkUserAllowed(userId, allowedUserIds)
      ? { allowed: true }
      : { allowed: false, reason: "not-allowlisted" };
  }
  if (allowedUserIds.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  if (!checkUserAllowed(userId, allowedUserIds)) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

/**
 * Sanitize user input to prevent prompt injection attacks.
 * Filters known dangerous patterns and truncates long messages.
 */
export function sanitizeInput(text: string): string {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    /you\s+are\s+now\s+/gi,
    /system:\s*/gi,
    /<\|.*?\|>/g, // special tokens
  ];

  let sanitized = text;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }

  const maxLength = 4000;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + "... [truncated]";
  }

  return sanitized;
}

/**
 * Sliding window rate limiter per user ID.
 */
export class RateLimiter {
  private readonly limiter: FixedWindowRateLimiter;
  private readonly limit: number;

  constructor(limit = 30, windowSeconds = 60, maxTrackedUsers = 5_000) {
    this.limit = limit;
    this.limiter = createFixedWindowRateLimiter({
      windowMs: Math.max(1, Math.floor(windowSeconds * 1000)),
      maxRequests: Math.max(1, Math.floor(limit)),
      maxTrackedKeys: Math.max(1, Math.floor(maxTrackedUsers)),
    });
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(userId: string): boolean {
    return !this.limiter.isRateLimited(userId);
  }

  /** Exposed for tests and diagnostics. */
  size(): number {
    return this.limiter.size();
  }

  /** Exposed for tests and account lifecycle cleanup. */
  clear(): void {
    this.limiter.clear();
  }

  /** Exposed for tests. */
  maxRequests(): number {
    return this.limit;
  }
}
