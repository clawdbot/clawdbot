/**
 * QQBot inbound access control — public entry points.
 *
 * Consumers (inbound-pipeline and future adapters) should import from
 * this barrel to keep the internal module layout opaque.
 */

export { resolveQQBotAccess, type QQBotAccessInput } from "./access-control.js";
export {
  createQQBotSenderMatcher,
  normalizeQQBotAllowFrom,
  normalizeQQBotSenderId,
} from "./sender-match.js";
export { resolveQQBotEffectivePolicies, type EffectivePolicyInput } from "./resolve-policy.js";
export {
  QQBOT_ACCESS_REASON,
  type QQBotAccessDecision,
  type QQBotAccessReasonCode,
  type QQBotAccessResult,
  type QQBotDmPolicy,
  type QQBotGroupPolicy,
} from "./types.js";
