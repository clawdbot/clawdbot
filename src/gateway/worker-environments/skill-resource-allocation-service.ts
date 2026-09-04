import { isSqliteLockError } from "../../infra/sqlite-transaction.js";
import {
  createSkillResourceAllocationCoordinator,
  type SkillResourceAllocationCoordinator,
  type SkillResourceAllocationRecoveryOptions,
} from "./skill-resource-allocation-coordinator.js";

type SkillResourceAllocationServiceOptions = {
  coordinator?: SkillResourceAllocationCoordinator;
  store: {
    get: SkillResourceAllocationRecoveryOptions["getEnvironment"];
    pruneTerminalEnvironments: () => void;
  };
  startTunnel: SkillResourceAllocationRecoveryOptions["startTunnel"];
  warn: (message: string) => void;
};

export function createSkillResourceAllocationService(
  options: SkillResourceAllocationServiceOptions,
) {
  const coordinator = options.coordinator ?? createSkillResourceAllocationCoordinator();
  const recoverAndPrune = async (): Promise<void> => {
    let terminalPruneSafe = true;
    try {
      await coordinator.recover({
        getEnvironment: options.store.get,
        startTunnel: options.startTunnel,
        onEnvironmentCleanupDeferred: () => {
          terminalPruneSafe = false;
        },
        warn: options.warn,
      });
    } catch {
      terminalPruneSafe = false;
      options.warn("Skill resource allocation cleanup failed; cleanup will retry");
    }
    if (!terminalPruneSafe) {
      return;
    }
    try {
      options.store.pruneTerminalEnvironments();
    } catch (error) {
      // Pruning is opportunistic and retries on the next sweep; lock contention must not
      // turn a healthy worker reconciliation into a startup or periodic-reconcile failure.
      if (!isSqliteLockError(error)) {
        throw error;
      }
    }
  };

  const startTunnel = async (request: Parameters<typeof options.startTunnel>[0]) => {
    const tunnel = await options.startTunnel(request);
    void coordinator
      .recover({
        getEnvironment: options.store.get,
        startTunnel: options.startTunnel,
        warn: options.warn,
      })
      .catch(() =>
        options.warn("Skill resource allocation reconnect cleanup failed; cleanup will retry"),
      );
    return tunnel;
  };

  return { coordinator, recoverAndPrune, startTunnel };
}
