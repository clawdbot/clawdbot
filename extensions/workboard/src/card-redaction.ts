import type { WorkboardCard } from "@openclaw/workboard-contract";

export function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  const objectiveEvidence = card.metadata?.reconciliationObjectiveEvidence;
  if (!claim && !objectiveEvidence) {
    return card;
  }
  const { reconciliationObjectiveEvidence: _objectiveEvidence, ...metadata } = card.metadata ?? {};
  return {
    ...card,
    metadata: {
      ...metadata,
      ...(claim
        ? {
            claim: {
              ...claim,
              token: "[redacted]",
            },
          }
        : {}),
    },
  };
}

/** Reconciliation is the sole generic read capability allowed to see objective evidence. */
export function redactReconciliationClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) return card;
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: { ...claim, token: "[redacted]" },
    },
  };
}
