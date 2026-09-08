import {
  clearSidebarAttentionDismissal,
  resolveScopeUpgradeDismissal,
  type SidebarAttentionDismissal,
} from "../components/sidebar-attention-dismissals.ts";
import type { SidebarInboxEntry } from "../components/sidebar-attention-entries.ts";
import type { AgentCapability } from "../lib/agents/index.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ScopeUpgradeCapability } from "./device-scope-upgrade.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { MentionsCapability } from "./mentions.ts";
import type { ApplicationOverlays } from "./overlays-types.ts";

export type SidebarAttentionStoreSources = {
  gateway: ApplicationGateway;
  agentSelection: AgentSelectionCapability;
  agents: AgentCapability;
  overlays: ApplicationOverlays;
  scopeUpgrade: ScopeUpgradeCapability;
  connectionBootstrap?: ConnectionBootstrapCoordinator;
};

export type SidebarAttentionStoreController = {
  readonly entries: readonly SidebarInboxEntry[];
  readonly mentions: MentionsCapability;
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
  activate(Controller: SidebarAttentionStoreControllerConstructor): MentionsCapability;
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
      !resolveScopeUpgradeDismissal({ scopes, state: sources.scopeUpgrade.state })
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
      return controller.mentions;
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
