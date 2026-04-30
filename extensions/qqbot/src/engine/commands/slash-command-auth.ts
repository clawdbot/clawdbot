/**
 * Pre-dispatch authorization for requireAuth slash commands.
 *
 * Unlike the access-stage's `resolveCommandAuthorized` (which permits
 * `dm_policy_open` senders — i.e. anyone), this function requires the
 * sender to appear in an **explicit non-wildcard** allowFrom list.
 *
 * Rationale: sensitive operations (log export, file deletion, approval
 * config changes) must be gated behind a deliberate operator decision.
 * A wide-open DM policy means "anyone can chat", not "anyone can run
 * admin commands".
 */

import { createQQBotSenderMatcher, normalizeQQBotAllowFrom } from "../access/index.js";

/**
 * Determine whether `senderId` is authorized to execute `requireAuth`
 * slash commands for the given account configuration.
 *
 * Authorization rules:
 * - `allowFrom` not configured / empty / only `["*"]` → **false**
 *   (wildcard means "open to everyone", not explicit authorization)
 * - `allowFrom` contains at least one concrete entry AND sender
 *   matches → **true**
 * - Group messages use `groupAllowFrom` when present, falling back
 *   to `allowFrom`.
 */
export function resolveSlashCommandAuth(params: {
  senderId: string;
  isGroup: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
}): boolean {
  const rawList =
    params.isGroup && params.groupAllowFrom && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : params.allowFrom;

  const normalized = normalizeQQBotAllowFrom(rawList);

  // Require at least one explicit (non-wildcard) entry.
  const hasExplicitEntry = normalized.some((entry) => entry !== "*");
  if (!hasExplicitEntry) {
    return false;
  }

  return createQQBotSenderMatcher(params.senderId)(normalized);
}
