/**
 * QQBot access-control primitive types.
 *
 * Mirrors the semantics of the framework-shared `DmPolicy` and
 * `DmGroupAccessDecision` types while staying zero-dependency so the
 * engine layer remains portable across the built-in and standalone
 * plugin builds.
 *
 * The reason codes here intentionally match
 * `src/security/dm-policy-shared.ts::DM_GROUP_ACCESS_REASON` so metric
 * dashboards can treat QQBot decisions identically to WhatsApp /
 * Telegram / Discord decisions.
 */

/** DM-level policy selecting between open / allowlist / disabled gating. */
export type QQBotDmPolicy = "open" | "allowlist" | "disabled";

/** Group-level policy selecting between open / allowlist / disabled gating. */
export type QQBotGroupPolicy = "open" | "allowlist" | "disabled";

/** High-level outcome returned by the access gate. */
export type QQBotAccessDecision = "allow" | "block";

/** Structured reason codes used in logs and metrics. */
export const QQBOT_ACCESS_REASON = {
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
  DM_POLICY_EMPTY_ALLOWLIST: "dm_policy_empty_allowlist",
  GROUP_POLICY_ALLOWED: "group_policy_allowed",
  GROUP_POLICY_DISABLED: "group_policy_disabled",
  GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
  GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
  BOT_SELF_ECHO: "bot_self_echo",
} as const;

export type QQBotAccessReasonCode = (typeof QQBOT_ACCESS_REASON)[keyof typeof QQBOT_ACCESS_REASON];

/** Result of the access gate evaluation. */
export interface QQBotAccessResult {
  decision: QQBotAccessDecision;
  reasonCode: QQBotAccessReasonCode;
  /** Human-readable reason suitable for logging. */
  reason: string;
  /** The allowFrom list that was actually compared against. */
  effectiveAllowFrom: string[];
  /** The groupAllowFrom list that was actually compared against. */
  effectiveGroupAllowFrom: string[];
  /** The dm/group policies that were used (after defaults were applied). */
  dmPolicy: QQBotDmPolicy;
  groupPolicy: QQBotGroupPolicy;
}
