import { clearSidebarAttentionDismissal } from "../components/sidebar-attention-dismissals.ts";
import {
  buildScopeUpgradeInboxEntry,
  type SidebarAttentionDismissal,
  type SidebarInboxEntry,
} from "../components/sidebar-attention-entries.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ScopeUpgradeCapability } from "./device-scope-upgrade.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";

export type SidebarAttentionStoreSources = {
  gateway: ApplicationGateway;
  agentSelection: AgentSelectionCapability;
  agents: AgentCapability;
  overlays: ApplicationOverlays;
  scopeUpgrade: ScopeUpgradeCapability;
};

export type SidebarAttentionStoreController = {
  readonly entries: readonly SidebarInboxEntry[];
  dismiss(dismissal: SidebarAttentionDismissal): void;
  syncDismissals(): void;
  dispose(): void;
};

type SidebarAttentionStoreControllerConstructor = new (
  sources: SidebarAttentionStoreSources,
  onChange: () => void,
) => SidebarAttentionStoreController;

export type SidebarAttentionStore = {
  readonly entries: readonly SidebarInboxEntry[];
  activate(Controller: SidebarAttentionStoreControllerConstructor): void;
  dismiss(dismissal: SidebarAttentionDismissal): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export function createSidebarAttentionStore(
  sources: SidebarAttentionStoreSources,
): SidebarAttentionStore {
  const listeners = new Set<() => void>();
  let controller: SidebarAttentionStoreController | null = null;
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  // Settings intentionally mounts no Inbox, so dismissal retirement belongs to this eager facade.
  const synchronizeScopeUpgradeDismissal = () => {
    const snapshot = sources.gateway.snapshot;
    const scopes = snapshot.hello?.auth?.scopes;
    if (
      snapshot.phase === "connected" &&
      scopes &&
      !buildScopeUpgradeInboxEntry({ scopes, state: sources.scopeUpgrade.state })?.dismissal
    ) {
      clearSidebarAttentionDismissal(sources.gateway.connection.gatewayUrl, "scopeUpgrade");
    }
    controller?.syncDismissals();
  };
  const stopGateway = sources.gateway.subscribe(synchronizeScopeUpgradeDismissal);
  const stopScopeUpgrade = sources.scopeUpgrade.subscribe(synchronizeScopeUpgradeDismissal);
  synchronizeScopeUpgradeDismissal();
  return {
    get entries() {
      return controller?.entries ?? [];
    },
    activate(Controller) {
      controller ??= new Controller(sources, publish);
    },
    dismiss(dismissal) {
      controller?.dismiss(dismissal);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopGateway();
      stopScopeUpgrade();
      controller?.dispose();
      controller = null;
      listeners.clear();
    },
  };
}
