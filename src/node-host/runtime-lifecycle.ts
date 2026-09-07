/** Owns disconnect cleanup and retryable final retirement for one node runtime. */
type Cleanup = () => void | Promise<void>;

export function createNodeHostRuntimeLifecycle(owners: {
  cancelInvocations: () => void;
  stopWatchers: Cleanup;
  abortStartup: () => void;
  closeSupervisor: Cleanup;
  closeMcp: Cleanup;
  releaseRegistry: Cleanup;
  disconnect: Cleanup;
  reportDisconnectFailure: (error: unknown) => void;
}) {
  let started = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let disconnectPromise: Promise<void> = Promise.resolve();
  let disconnectFailed = false;
  let supervisorClose: Promise<void> | undefined;
  let mcpClose: Promise<void> | undefined;

  const disconnect = () => {
    // Startup rollback has no admitted connection work to disconnect.
    if (!started) {
      return;
    }
    const cleanup = disconnectPromise.catch(() => {}).then(async () => await owners.disconnect());
    disconnectPromise = cleanup;
    disconnectFailed = false;
    // Logging observes failure; admission and shutdown retain the actual rejected result.
    void cleanup.catch((error: unknown) => {
      if (disconnectPromise === cleanup) {
        disconnectFailed = true;
      }
      owners.reportDisconnectFailure(error);
    });
  };

  const lifecycle = {
    async start<T>(construct: () => T): Promise<T> {
      try {
        const runtime = construct();
        started = true;
        return runtime;
      } catch (error) {
        try {
          await lifecycle.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "node-host startup and cleanup failed", {
            cause: cleanupError,
          });
        }
        throw error;
      }
    },
    get closing() {
      return closing;
    },
    disconnect,
    awaitDisconnect: () => disconnectPromise,
    close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      if (!closing) {
        closing = true;
        owners.cancelInvocations();
        disconnect();
      } else if (disconnectFailed) {
        disconnect();
      }
      // Stop notification admission synchronously, then join independent cleanup in parallel.
      const watcherClose = (async () => await owners.stopWatchers())();
      if (!mcpClose) {
        owners.abortStartup();
        mcpClose = Promise.resolve().then(async () => await owners.closeMcp());
      }
      supervisorClose ??= Promise.resolve()
        .then(async () => await owners.closeSupervisor())
        .catch((error: unknown) => {
          // The supervisor retains unfinished worker retirement for an explicit retry.
          supervisorClose = undefined;
          throw error;
        });
      closePromise = Promise.allSettled([
        watcherClose,
        disconnectPromise,
        supervisorClose,
        mcpClose,
      ])
        .then(async (results) => {
          // Watcher stop and disconnect can observe the same physical-close rejection.
          const errors = [
            ...new Set(
              results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
            ),
          ];
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw new AggregateError(errors, "node-host runtime close failed");
          }
          await owners.releaseRegistry();
        })
        .catch((error: unknown) => {
          // Successful retirement stays cached while failed owners remain retryable.
          closePromise = undefined;
          throw error;
        });
      return closePromise;
    },
  };
  return lifecycle;
}
