import {
  readScopeUpgradeAvailability,
  type ScopeUpgradeState,
} from "./device-scope-upgrade-availability.ts";
import type { ScopeUpgradeController } from "./device-scope-upgrade-controller.runtime.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";

type ScopeUpgradeControllerConstructor = new (
  initial: ApplicationGatewaySnapshot,
  onChange: () => void,
) => ScopeUpgradeController;

export type ScopeUpgradeCapability = {
  readonly state: ScopeUpgradeState;
  activate(Controller: ScopeUpgradeControllerConstructor): void;
  request(): void;
  retry(): void;
  cancel(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

/** App-lifetime state shared by every Inbox presenter and settings takeover. */
export function createScopeUpgradeCapability(gateway: ApplicationGateway): ScopeUpgradeCapability {
  const listeners = new Set<() => void>();
  let snapshot = gateway.snapshot;
  let controller: ScopeUpgradeController | null = null;
  let state = readScopeUpgradeAvailability(snapshot);

  const publish = (next: ScopeUpgradeState) => {
    if (JSON.stringify(state) === JSON.stringify(next)) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const syncController = () => {
    if (controller) {
      publish(controller.state);
    }
  };
  const syncGateway = (next: ApplicationGatewaySnapshot) => {
    snapshot = next;
    controller?.sync(snapshot);
    publish(controller?.state ?? readScopeUpgradeAvailability(snapshot));
  };
  const stopGateway = gateway.subscribe(syncGateway);

  return {
    get state() {
      return state;
    },
    activate(Controller) {
      controller ??= new Controller(snapshot, syncController);
      controller.sync(snapshot);
      publish(controller.state);
    },
    request: () => controller?.request(),
    retry: () => controller?.retry(),
    cancel: () => controller?.cancel(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopGateway();
      controller?.dispose();
      controller = null;
      listeners.clear();
    },
  };
}
