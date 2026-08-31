export type GatewayEventDispatchOwner = {
  tryRun: (start: () => Promise<void>) => boolean;
  stopAndDrain: () => Promise<void>;
};

/** Owns admitted async event dispatches until subscription teardown drains them. */
export function createGatewayEventDispatchOwner(): GatewayEventDispatchOwner {
  let accepting = true;
  const pending = new Set<Promise<void>>();

  return {
    tryRun(start) {
      if (!accepting) {
        return false;
      }
      let dispatch: Promise<void>;
      try {
        dispatch = start();
      } catch (error) {
        dispatch = Promise.reject(
          error instanceof Error
            ? error
            : new Error("Event dispatch start failed", { cause: error }),
        );
      }
      pending.add(dispatch);
      void dispatch.then(
        () => pending.delete(dispatch),
        () => pending.delete(dispatch),
      );
      return true;
    },
    async stopAndDrain() {
      accepting = false;
      await Promise.allSettled(pending);
    },
  };
}
