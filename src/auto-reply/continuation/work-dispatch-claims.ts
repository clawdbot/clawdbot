const CONTINUATION_WORK_RESET_ABORT_REASON = "session-reset";
const activeWorkDispatchControllers = new Map<string, Set<AbortController>>();

export function registerContinuationWorkDispatchClaim(sessionKey: string): {
  controller: AbortController;
  release: () => void;
} {
  const controller = new AbortController();
  const controllers = activeWorkDispatchControllers.get(sessionKey) ?? new Set<AbortController>();
  controllers.add(controller);
  activeWorkDispatchControllers.set(sessionKey, controllers);
  return {
    controller,
    release: () => {
      controllers.delete(controller);
      if (controllers.size === 0 && activeWorkDispatchControllers.get(sessionKey) === controllers) {
        activeWorkDispatchControllers.delete(sessionKey);
      }
    },
  };
}

export function abortContinuationWorkDispatchClaims(sessionKey: string): void {
  const controllers = activeWorkDispatchControllers.get(sessionKey);
  activeWorkDispatchControllers.delete(sessionKey);
  for (const controller of controllers ?? []) {
    controller.abort(CONTINUATION_WORK_RESET_ABORT_REASON);
  }
}

export function resetContinuationWorkDispatchClaimsForTests(): void {
  for (const sessionKey of activeWorkDispatchControllers.keys()) {
    abortContinuationWorkDispatchClaims(sessionKey);
  }
}
