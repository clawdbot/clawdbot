type SignalExitBarrier = () => Promise<void>;

// Gates let bounded mutations finish before signal cleanup begins; barriers
// then prevent one cleanup from exiting while another still owns state.
const activeBarriers = new Set<SignalExitBarrier>();
const activeGates = new Set<Promise<void>>();

export function registerSignalExitGate(gate: Promise<void>): () => void {
  activeGates.add(gate);
  return () => activeGates.delete(gate);
}

export function registerSignalExitBarrier(barrier: SignalExitBarrier): () => void {
  activeBarriers.add(barrier);
  return () => activeBarriers.delete(barrier);
}

export async function waitForSignalExitBarriers(): Promise<void> {
  const gateResults = await Promise.allSettled(activeGates);
  const barrierResults = await Promise.allSettled([...activeBarriers].map((barrier) => barrier()));
  const failures = [...gateResults, ...barrierResults]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Signal exit cleanup failed");
  }
}
