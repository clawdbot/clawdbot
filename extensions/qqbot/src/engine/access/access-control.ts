/**
 * QQBot inbound access decision.
 *
 * This module is the single place where the QQBot engine decides
 * whether an inbound message from a given sender is allowed to
 * proceed into the outbound pipeline. The implementation mirrors the
 * semantics of the framework-wide `resolveDmGroupAccessDecision`
 * (`src/security/dm-policy-shared.ts`) but is kept standalone so the
 * `engine/` layer does not pull in `openclaw/plugin-sdk/*` modules —
 * a hard constraint shared with the standalone `openclaw-qqbot` build.
 *
 * If in the future we lift the zero-dependency rule in the engine
 * layer, this file can be replaced by a thin adapter around the
 * framework API with identical semantics.
 */

import { resolveQQBotEffectivePolicies, type EffectivePolicyInput } from "./resolve-policy.js";
import { createQQBotSenderMatcher, normalizeQQBotAllowFrom } from "./sender-match.js";
import {
  QQBOT_ACCESS_REASON,
  type QQBotAccessResult,
  type QQBotDmPolicy,
  type QQBotGroupPolicy,
} from "./types.js";

export interface QQBotAccessInput extends EffectivePolicyInput {
  /** Whether the inbound originated in a group (or guild) chat. */
  isGroup: boolean;
  /** The raw inbound sender id as provided by the QQ event. */
  senderId: string;
}

/**
 * Evaluate the inbound access policy.
 *
 * Semantics (aligned with `resolveDmGroupAccessDecision`):
 *   - Group message:
 *     - `groupPolicy=disabled` → block
 *     - `groupPolicy=open`     → allow
 *     - `groupPolicy=allowlist`:
 *         - empty effectiveGroupAllowFrom → block (empty_allowlist)
 *         - sender not in list            → block (not_allowlisted)
 *         - otherwise                     → allow
 *   - Direct message:
 *     - `dmPolicy=disabled`    → block
 *     - `dmPolicy=open`        → allow
 *     - `dmPolicy=allowlist`:
 *         - empty effectiveAllowFrom → block (empty_allowlist)
 *         - sender not in list       → block (not_allowlisted)
 *         - otherwise                → allow
 *
 * The function never throws; callers can rely on the returned
 * `decision`/`reasonCode` pair for branching.
 */
export function resolveQQBotAccess(input: QQBotAccessInput): QQBotAccessResult {
  const { dmPolicy, groupPolicy } = resolveQQBotEffectivePolicies(input);

  // Per framework convention: groupAllowFrom falls back to allowFrom
  // when not provided. We preserve that behaviour so a single
  // `allowFrom` entry locks down both DM and group.
  const rawGroupAllowFrom =
    input.groupAllowFrom && input.groupAllowFrom.length > 0
      ? input.groupAllowFrom
      : (input.allowFrom ?? []);

  const effectiveAllowFrom = normalizeQQBotAllowFrom(input.allowFrom);
  const effectiveGroupAllowFrom = normalizeQQBotAllowFrom(rawGroupAllowFrom);

  const isSenderAllowed = createQQBotSenderMatcher(input.senderId);

  if (input.isGroup) {
    return evaluateGroupDecision({
      groupPolicy,
      dmPolicy,
      effectiveAllowFrom,
      effectiveGroupAllowFrom,
      isSenderAllowed,
    });
  }

  return evaluateDmDecision({
    groupPolicy,
    dmPolicy,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    isSenderAllowed,
  });
}

// ---- internal helpers ------------------------------------------------

interface DecisionContext {
  dmPolicy: QQBotDmPolicy;
  groupPolicy: QQBotGroupPolicy;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  isSenderAllowed: (allowFrom: string[]) => boolean;
}

function evaluateGroupDecision(ctx: DecisionContext): QQBotAccessResult {
  const base = buildResultBase(ctx);

  if (ctx.groupPolicy === "disabled") {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_DISABLED,
      reason: "groupPolicy=disabled",
    };
  }

  if (ctx.groupPolicy === "open") {
    return {
      ...base,
      decision: "allow",
      reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_ALLOWED,
      reason: "groupPolicy=open",
    };
  }

  // groupPolicy === "allowlist"
  if (ctx.effectiveGroupAllowFrom.length === 0) {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
      reason: "groupPolicy=allowlist (empty allowlist)",
    };
  }

  if (!ctx.isSenderAllowed(ctx.effectiveGroupAllowFrom)) {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
      reason: "groupPolicy=allowlist (not allowlisted)",
    };
  }

  return {
    ...base,
    decision: "allow",
    reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_ALLOWED,
    reason: "groupPolicy=allowlist (allowlisted)",
  };
}

function evaluateDmDecision(ctx: DecisionContext): QQBotAccessResult {
  const base = buildResultBase(ctx);

  if (ctx.dmPolicy === "disabled") {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_DISABLED,
      reason: "dmPolicy=disabled",
    };
  }

  if (ctx.dmPolicy === "open") {
    return {
      ...base,
      decision: "allow",
      reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_OPEN,
      reason: "dmPolicy=open",
    };
  }

  // dmPolicy === "allowlist"
  if (ctx.effectiveAllowFrom.length === 0) {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_EMPTY_ALLOWLIST,
      reason: "dmPolicy=allowlist (empty allowlist)",
    };
  }

  if (!ctx.isSenderAllowed(ctx.effectiveAllowFrom)) {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
      reason: "dmPolicy=allowlist (not allowlisted)",
    };
  }

  return {
    ...base,
    decision: "allow",
    reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
    reason: "dmPolicy=allowlist (allowlisted)",
  };
}

function buildResultBase(
  ctx: DecisionContext,
): Pick<
  QQBotAccessResult,
  "effectiveAllowFrom" | "effectiveGroupAllowFrom" | "dmPolicy" | "groupPolicy"
> {
  return {
    effectiveAllowFrom: ctx.effectiveAllowFrom,
    effectiveGroupAllowFrom: ctx.effectiveGroupAllowFrom,
    dmPolicy: ctx.dmPolicy,
    groupPolicy: ctx.groupPolicy,
  };
}
