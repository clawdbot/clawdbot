/**
 * Process-local state for warmed provider auth snapshots.
 */
export type PreparedProviderAuthState = {
  agentId: string;
  configFingerprint: string;
  providers: ReadonlyMap<string, boolean>;
};

export type ProviderAuthWarmSnapshot = {
  agents: Array<{
    agentId: string;
    configFingerprint: string;
    providers: Array<[string, boolean]>;
  }>;
};

type ProviderAuthWarmWorkerHandle = {
  worker: {
    terminate: () => unknown;
  };
  cancelled: boolean;
};

// One entry per configured agent, keyed by agentId. Populated by the provider
// auth warm path; consulted by hasAuthForModelProvider on every model-listing call.
let currentProviderAuthStates: ReadonlyMap<string, PreparedProviderAuthState> | null = null;

// Generation counter guards against an in-flight warm publishing stale state
// after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;
let currentProviderAuthWarmWorker: ProviderAuthWarmWorkerHandle | undefined;

export function getCurrentProviderAuthStates(): ReadonlyMap<
  string,
  PreparedProviderAuthState
> | null {
  return currentProviderAuthStates;
}

export function claimCurrentProviderAuthStateGeneration(): number {
  currentProviderAuthStateGeneration += 1;
  return currentProviderAuthStateGeneration;
}

export function isCurrentProviderAuthStateGeneration(generation: number): boolean {
  return generation === currentProviderAuthStateGeneration;
}

export function setCurrentProviderAuthWarmWorker(handle: ProviderAuthWarmWorkerHandle): void {
  currentProviderAuthWarmWorker = handle;
}

export function clearCurrentProviderAuthWarmWorker(handle: ProviderAuthWarmWorkerHandle): void {
  if (currentProviderAuthWarmWorker === handle) {
    currentProviderAuthWarmWorker = undefined;
  }
}

export function cancelCurrentProviderAuthWarmWorker(): void {
  const current = currentProviderAuthWarmWorker;
  if (!current) {
    return;
  }
  current.cancelled = true;
  currentProviderAuthWarmWorker = undefined;
  void current.worker.terminate();
}

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthStates = null;
  claimCurrentProviderAuthStateGeneration();
  cancelCurrentProviderAuthWarmWorker();
}

export function publishProviderAuthWarmSnapshot(snapshot: ProviderAuthWarmSnapshot): void {
  currentProviderAuthStates = new Map(
    snapshot.agents.map((state) => [
      state.agentId,
      {
        agentId: state.agentId,
        configFingerprint: state.configFingerprint,
        providers: new Map(state.providers),
      },
    ]),
  );
}
