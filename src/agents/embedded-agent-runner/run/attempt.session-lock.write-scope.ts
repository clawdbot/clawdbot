import type { OwnedSessionTranscriptPublishedEntry } from "../../../config/sessions/transcript-write-context.js";

type PhysicalWriteLockScope = {
  active: boolean;
  completion: Promise<void>;
  pendingOperations: Set<Promise<void>>;
};

export type ActiveWriteLockState =
  | {
      active: boolean;
      scope: PhysicalWriteLockScope;
      publishingOwnedWrite: false;
    }
  | {
      active: boolean;
      scope: PhysicalWriteLockScope;
      publishingOwnedWrite: true;
      acceptingNestedPublications: boolean;
      pendingNestedPublications: Set<Promise<void>>;
      publishedEntries?: OwnedSessionTranscriptPublishedEntry[];
    };

type RootWriteLockState = Extract<ActiveWriteLockState, { publishingOwnedWrite: false }>;

export function createActiveWriteLockScope(): {
  state: RootWriteLockState;
  complete: () => void;
} {
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    state: {
      active: true,
      scope: {
        active: true,
        completion,
        pendingOperations: new Set(),
      },
      publishingOwnedWrite: false,
    },
    complete,
  };
}

export function trackWriteLockOperation<T>(
  scope: PhysicalWriteLockScope,
  operation: Promise<T>,
  additionalSet?: Set<Promise<void>>,
): Promise<T> {
  const settlement = operation.then(
    () => undefined,
    () => undefined,
  );
  scope.pendingOperations.add(settlement);
  additionalSet?.add(settlement);
  void settlement.finally(() => {
    scope.pendingOperations.delete(settlement);
    additionalSet?.delete(settlement);
  });
  return operation;
}

export async function drainWriteLockScope(scope: PhysicalWriteLockScope): Promise<void> {
  while (scope.pendingOperations.size > 0) {
    await Promise.all(scope.pendingOperations);
  }
}
