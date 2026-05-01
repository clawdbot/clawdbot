/**
 * QQBot inbound access control — public entry points.
 *
 * Consumers (inbound-pipeline and future adapters) should import from
 * this barrel to keep the internal module layout opaque.
 */

export { resolveQQBotAccess } from "./access-control.js";
export { createQQBotSenderMatcher, normalizeQQBotAllowFrom } from "./sender-match.js";
export {
  type QQBotAccessDecision,
  type QQBotAccessReasonCode,
  type QQBotAccessResult,
  type QQBotDmPolicy,
  type QQBotGroupPolicy,
} from "./types.js";
