export function createAppliedConfigHashPublisher(options: {
  hasPendingRestart: () => boolean;
  publish: (hash: string) => void;
}) {
  let deferredHash: string | null = null;
  return {
    hasOutstandingGatewayRestart: options.hasPendingRestart,
    publishAppliedConfigHash: (hash: string) => {
      // A hot-only edit can land behind restart debt. Keep the newest revision
      // private until that debt retires; a replacement Gateway sets startup truth.
      if (options.hasPendingRestart()) {
        deferredHash = hash;
        return;
      }
      deferredHash = null;
      options.publish(hash);
    },
    publishDeferredAppliedConfigHash: () => {
      if (deferredHash === null || options.hasPendingRestart()) {
        return;
      }
      const hash = deferredHash;
      deferredHash = null;
      options.publish(hash);
    },
  };
}
