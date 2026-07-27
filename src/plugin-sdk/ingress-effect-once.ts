import { createClaimableDedupe, runClaimableDedupeClaimLoop } from "./persistent-dedupe.js";

const INGRESS_EFFECT_ONCE_NAMESPACE_PREFIX = "ingress-effect-once";

class IngressEffectRunFailedError extends Error {
  constructor() {
    super("ingress effect failed before its durable commit");
    this.name = "IngressEffectRunFailedError";
  }
}

/**
 * Create a durable per-event side-effect guard for channel ingress drains.
 *
 * Create one factory per ingress queue/account scope and give that scope a stable, unique
 * `namespacePrefix`; `eventId` only needs to be unique within that queue. Storage failures
 * reject instead of falling back to process memory.
 *
 * `ttlMs` must cover the maximum effect-commit-to-tombstone delay plus the channel's
 * ingress tombstone retention. Older records are dead weight once the tombstone prevents
 * replay. A process death after `run()` succeeds but before the claim commits can still
 * execute the effect again on recovery, as can a storage failure during that commit.
 */
export function createIngressEffectOnce(params: {
  pluginId: string;
  namespacePrefix: string;
  ttlMs: number;
  stateMaxEntries: number;
  memoryMaxSize?: number;
  onDiskError?: (error: unknown) => void;
}): {
  runOnce: <T>(params: {
    eventId: string;
    effect: string;
    run: () => Promise<T>;
  }) => Promise<{ kind: "executed"; value: T } | { kind: "replayed" }>;
} {
  const dedupe = createClaimableDedupe({
    pluginId: params.pluginId,
    namespacePrefix: INGRESS_EFFECT_ONCE_NAMESPACE_PREFIX,
    ttlMs: params.ttlMs,
    stateMaxEntries: params.stateMaxEntries,
    memoryMaxSize: params.memoryMaxSize ?? params.stateMaxEntries,
    onDiskError: (error) => {
      params.onDiskError?.(error);
      throw error;
    },
  });

  return {
    runOnce: async <T>(effectParams: {
      eventId: string;
      effect: string;
      run: () => Promise<T>;
    }): Promise<{ kind: "executed"; value: T } | { kind: "replayed" }> => {
      const key = JSON.stringify([effectParams.effect, effectParams.eventId]);
      const namespace = params.namespacePrefix;

      // The persistent-dedupe namespace path hashes this raw queue/account scope.
      const claim = await runClaimableDedupeClaimLoop(
        () => dedupe.claim(key, { namespace }),
        // Only an effect failure is safe to retry; commit failures may follow a visible effect.
        (error) => {
          if (error instanceof IngressEffectRunFailedError) {
            return true;
          }
          throw error;
        },
      );
      if (claim.kind === "duplicate") {
        return { kind: "replayed" };
      }

      let value: T;
      try {
        value = await effectParams.run();
      } catch (error) {
        dedupe.release(key, { namespace, error: new IngressEffectRunFailedError() });
        throw error;
      }
      try {
        await dedupe.commit(key, { namespace });
      } catch (error) {
        try {
          // forget clears the failed commit's memory marker before its durable delete attempt.
          await dedupe.forget(key, {
            namespace,
            onDiskError: (cleanupError) => {
              throw cleanupError;
            },
          });
        } catch {
          // Keep the original commit error; the configured hook already reported it.
        }
        throw error;
      }
      return { kind: "executed", value };
    },
  };
}
