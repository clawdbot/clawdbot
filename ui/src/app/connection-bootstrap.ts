/** Coordinates automatic Control UI bootstrap work for one Gateway connection epoch. */

export type ConnectionBootstrapCoordinator = {
  reset: () => void;
  run: (key: string, task: () => Promise<unknown>) => Promise<void>;
  synchronize: (params: { client: object | null; connected: boolean }) => void;
};

/** Loads connection-only bootstrap scheduling after a Gateway connection first needs it. */
export function createConnectionBootstrapCoordinator(): ConnectionBootstrapCoordinator {
  let runtime: Promise<ConnectionBootstrapCoordinator> | undefined;
  const load = () =>
    (runtime ??= import("./connection-bootstrap.runtime.ts").then(
      ({ createConnectionBootstrapRuntime }) => createConnectionBootstrapRuntime(),
    ));

  return {
    reset: () => {
      void runtime?.then((coordinator) => coordinator.reset());
    },
    run: (key, task) => load().then((coordinator) => coordinator.run(key, task)),
    synchronize: (params) => {
      if (params.connected || runtime) {
        void load().then((coordinator) => coordinator.synchronize(params));
      }
    },
  };
}
