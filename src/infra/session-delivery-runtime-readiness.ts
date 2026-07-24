export type SessionDeliveryRuntimeReadinessSnapshot = {
  active: boolean;
  generation: number;
};

let snapshot: SessionDeliveryRuntimeReadinessSnapshot = { active: false, generation: 0 };

export function publishSessionDeliveryRuntimeReadiness(
  next: SessionDeliveryRuntimeReadinessSnapshot,
): void {
  if (next.generation < snapshot.generation) {
    return;
  }
  snapshot = { ...next };
}

export function getSessionDeliveryRuntimeReadiness(): SessionDeliveryRuntimeReadinessSnapshot {
  return { ...snapshot };
}
