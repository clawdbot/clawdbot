import "./session-write-lock.js";

type SessionWriteLockTestApi = {
  resetSessionWriteLockStateForTest(): void;
  testing: {
    releaseAllLocksSync(): void;
    setProcessStartTimeResolverForTest(resolver: ((pid: number) => number | null) | null): void;
  };
};

function getTestApi(): SessionWriteLockTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionWriteLockTestApi")
  ] as SessionWriteLockTestApi;
}

export function resetSessionWriteLockStateForTest(): void {
  getTestApi().resetSessionWriteLockStateForTest();
}

export const testing: SessionWriteLockTestApi["testing"] = {
  releaseAllLocksSync() {
    return getTestApi().testing.releaseAllLocksSync();
  },
  setProcessStartTimeResolverForTest(resolver) {
    return getTestApi().testing.setProcessStartTimeResolverForTest(resolver);
  },
};
