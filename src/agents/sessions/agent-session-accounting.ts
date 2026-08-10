export type AgentSubmissionHandle = {
  settle: (outcome: "completed" | "failed") => void;
};

export type AgentSubmissionObserver = () => AgentSubmissionHandle;
export type ModelCallObserver = AgentSubmissionObserver;

export type AgentSessionAccountingObservers = {
  onAgentSubmission?: AgentSubmissionObserver;
  onCoreCompactionInvocation?: () => void;
  onExtensionCompactionInvocation?: () => void;
};

const observers = new WeakMap<object, AgentSessionAccountingObservers>();

export function bindAgentSessionAccounting<T extends object>(
  target: T,
  value: AgentSessionAccountingObservers | undefined,
): T {
  if (
    value?.onAgentSubmission ||
    value?.onCoreCompactionInvocation ||
    value?.onExtensionCompactionInvocation
  ) {
    observers.set(target, value);
  }
  return target;
}

export function resolveAgentSessionAccounting(
  target: object,
): AgentSessionAccountingObservers | undefined {
  return observers.get(target);
}

export function copyAgentSessionAccounting<T extends object>(source: object, target: T): T {
  return bindAgentSessionAccounting(target, observers.get(source));
}
