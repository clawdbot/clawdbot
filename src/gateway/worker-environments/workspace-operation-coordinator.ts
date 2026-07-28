export type WorkerWorkspaceOperationCoordinator = {
  run<T>(environmentId: string, operation: () => Promise<T>): Promise<T>;
};

/** Serializes local workspace mutation and forced teardown per environment. */
export function createWorkerWorkspaceOperationCoordinator(): WorkerWorkspaceOperationCoordinator {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(environmentId) ?? Promise.resolve();
      const result = previous.catch(() => undefined).then(operation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(environmentId, tail);
      void tail.finally(() => {
        if (tails.get(environmentId) === tail) {
          tails.delete(environmentId);
        }
      });
      return await result;
    },
  };
}
