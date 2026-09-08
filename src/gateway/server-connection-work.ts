import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";

/** Owns received work and connection cleanup until this Gateway generation settles. */
export class GatewayConnectionWork extends AsyncWorkScope {
  private readonly connections = new Set<() => void>();
  private failure: { error: unknown } | undefined;

  trackCleanup(run: () => Promise<void>): Promise<void> {
    // Settled request errors are outcomes, not failed teardown. Only cleanup
    // failure prevents the generation from declaring its dependencies releasable.
    return this.track(async () => {
      try {
        await run();
      } catch (error) {
        this.failure ??= { error };
        throw error;
      }
    });
  }

  registerConnection(close: () => void): () => void {
    const closed = createDeferredCore();
    this.connections.add(close);
    void this.track(() => closed.promise);
    return () => {
      this.connections.delete(close);
      closed.resolve();
    };
  }

  override async drain(): Promise<void> {
    this.beginClose();
    // Connection-dependent owners finish their node cleanup before this boundary.
    // Disconnect then settles ordinary invokes; their finalizers still belong to us.
    for (const close of this.connections) {
      this.connections.delete(close);
      try {
        close();
      } catch (error) {
        this.failure ??= { error };
      }
    }
    await super.drain();
    if (this.failure) {
      throw new Error("Gateway connection work failed to close cleanly", {
        cause: this.failure.error,
      });
    }
  }
}
