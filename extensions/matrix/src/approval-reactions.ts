import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-runtime";

const MATRIX_APPROVAL_REACTION_META = {
  "allow-once": {
    emoji: "✅",
    label: "Allow once",
  },
  "allow-always": {
    emoji: "♾️",
    label: "Allow always",
  },
  deny: {
    emoji: "❌",
    label: "Deny",
  },
} satisfies Record<ExecApprovalReplyDecision, { emoji: string; label: string }>;

const MATRIX_APPROVAL_REACTION_ORDER = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalReplyDecision[];

type MatrixApprovalReactionBinding = {
  decision: ExecApprovalReplyDecision;
  emoji: string;
  label: string;
};

type MatrixApprovalReactionResolution = {
  approvalId: string;
  decision: ExecApprovalReplyDecision;
};

type MatrixApprovalReactionTarget = {
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
};

const matrixApprovalReactionTargets = new Map<string, MatrixApprovalReactionTarget>();

function buildReactionTargetKey(roomId: string, eventId: string): string | null {
  const normalizedRoomId = roomId.trim();
  const normalizedEventId = eventId.trim();
  if (!normalizedRoomId || !normalizedEventId) {
    return null;
  }
  return `${normalizedRoomId}:${normalizedEventId}`;
}

export function listMatrixApprovalReactionBindings(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): MatrixApprovalReactionBinding[] {
  const allowed = new Set(allowedDecisions);
  return MATRIX_APPROVAL_REACTION_ORDER.filter((decision) => allowed.has(decision)).map(
    (decision) => ({
      decision,
      emoji: MATRIX_APPROVAL_REACTION_META[decision].emoji,
      label: MATRIX_APPROVAL_REACTION_META[decision].label,
    }),
  );
}

export function buildMatrixApprovalReactionHint(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): string | null {
  const bindings = listMatrixApprovalReactionBindings(allowedDecisions);
  if (bindings.length === 0) {
    return null;
  }
  return `React here: ${bindings.map((binding) => `${binding.emoji} ${binding.label}`).join(", ")}`;
}

function resolveMatrixApprovalReactionDecision(
  reactionKey: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalReplyDecision | null {
  const normalizedReaction = reactionKey.trim();
  if (!normalizedReaction) {
    return null;
  }
  const allowed = new Set(allowedDecisions);
  for (const decision of MATRIX_APPROVAL_REACTION_ORDER) {
    if (!allowed.has(decision)) {
      continue;
    }
    if (MATRIX_APPROVAL_REACTION_META[decision].emoji === normalizedReaction) {
      return decision;
    }
  }
  return null;
}

export function registerMatrixApprovalReactionTarget(params: {
  roomId: string;
  eventId: string;
  approvalId: string;
  allowedDecisions: readonly ExecApprovalReplyDecision[];
}): void {
  const key = buildReactionTargetKey(params.roomId, params.eventId);
  const approvalId = params.approvalId.trim();
  const allowedDecisions = Array.from(
    new Set(
      params.allowedDecisions.filter(
        (decision): decision is ExecApprovalReplyDecision =>
          decision === "allow-once" || decision === "allow-always" || decision === "deny",
      ),
    ),
  );
  if (!key || !approvalId || allowedDecisions.length === 0) {
    return;
  }
  matrixApprovalReactionTargets.set(key, {
    approvalId,
    allowedDecisions,
  });
}

export function unregisterMatrixApprovalReactionTarget(params: {
  roomId: string;
  eventId: string;
}): void {
  const key = buildReactionTargetKey(params.roomId, params.eventId);
  if (!key) {
    return;
  }
  matrixApprovalReactionTargets.delete(key);
}

export function resolveMatrixApprovalReactionTarget(params: {
  roomId: string;
  eventId: string;
  reactionKey: string;
}): MatrixApprovalReactionResolution | null {
  const key = buildReactionTargetKey(params.roomId, params.eventId);
  if (!key) {
    return null;
  }
  const target = matrixApprovalReactionTargets.get(key);
  if (!target) {
    return null;
  }
  const decision = resolveMatrixApprovalReactionDecision(
    params.reactionKey,
    target.allowedDecisions,
  );
  if (!decision) {
    return null;
  }
  return {
    approvalId: target.approvalId,
    decision,
  };
}

export function clearMatrixApprovalReactionTargetsForTest(): void {
  matrixApprovalReactionTargets.clear();
}
