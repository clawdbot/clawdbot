import type {
  BoardCommandEvent,
  BoardGetParams,
  BoardOp,
  BoardSnapshot,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  normalizeDefaultMainSessionAliasForUi,
  resolveUiConversationIdentity,
} from "../sessions/session-key.ts";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import { emptyBoardSnapshot } from "./provider-helpers.ts";
import {
  EventStream,
  ValueSignal,
  type BoardEventStream,
  type BoardSnapshotSignal,
} from "./provider-signals.ts";
import type { BoardPinMcpAppInput, BoardPinWidgetInput, BoardProvider } from "./provider-types.ts";
import type { BoardWidgetAppViewState } from "./view-types.ts";
export type { BoardCommandEvent };
export type { BoardProvider } from "./provider-types.ts";
export type { BoardViewCallbacks, BoardWidgetAppViewState } from "./view-types.ts";
export { canvasWidgetNameForDocument, mcpAppWidgetNameForViewId } from "./widget-names.ts";

type BoardGatewayClient = Pick<GatewayBrowserClient, "request" | "addEventListener">;

export function boardExists(snapshot: BoardSnapshot): boolean {
  return snapshot.tabs.length > 0 || snapshot.widgets.length > 0;
}

class NullProvider implements BoardProvider {
  readonly appViewGeneration = 0;
  readonly canMutate = false;
  readonly canGrant = false;
  readonly canPinWidgets = false;
  readonly canPinMcpApps = false;
  readonly hasLoadedSnapshot = true;
  readonly loadError$ = new ValueSignal<string | null>(null);
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent> = new EventStream<BoardCommandEvent>();

  constructor(readonly sessionKey = "") {
    this.snapshot$ = new ValueSignal(emptyBoardSnapshot(sessionKey));
  }

  async applyOps(_ops: BoardOp[]): Promise<void> {}

  async grant(_name: string, _decision: "granted" | "rejected"): Promise<void> {}

  async pinWidget(_input: BoardPinWidgetInput): Promise<void> {
    throw new Error("Session dashboard unavailable");
  }

  async pinMcpApp(_input: BoardPinMcpAppInput): Promise<void> {
    throw new Error("Session dashboard unavailable");
  }

  widgetFrameUrl(_name: string, _revision: number): string {
    return "";
  }

  async refreshWidgetFrame(_name: string): Promise<void> {}

  async widgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "Session dashboard unavailable" };
  }

  async refreshWidgetAppView(_name: string, _revision: number): Promise<BoardWidgetAppViewState> {
    return { status: "stale", error: "Session dashboard unavailable" };
  }
}

type BoardProviderCapabilities = Pick<
  BoardProvider,
  "canPinWidgets" | "canPinMcpApps" | "canMutate" | "canGrant"
>;

// Snapshots and gateway subscriptions are session-owned, but authority belongs
// to each live consumer; sharing it would let another dashboard widen an action.
class ScopedGatewayBoardProvider implements BoardProvider {
  readonly loadError$: BoardSnapshotSignal<string | null>;
  readonly snapshot$: BoardSnapshotSignal<BoardSnapshot>;
  readonly events: BoardEventStream<BoardCommandEvent>;
  private active = true;

  constructor(
    private readonly transport: GatewayBoardProvider,
    private capabilities: BoardProviderCapabilities,
  ) {
    this.loadError$ = transport.loadError$;
    this.snapshot$ = transport.snapshot$;
    this.events = transport.events;
  }

  get sessionKey(): string {
    return this.transport.sessionKey;
  }

  get appViewGeneration(): number {
    return this.transport.appViewGeneration;
  }

  get canPinWidgets(): boolean {
    return this.active && this.capabilities.canPinWidgets;
  }

  get canPinMcpApps(): boolean {
    return this.active && this.capabilities.canPinMcpApps;
  }

  get canMutate(): boolean {
    return this.active && this.capabilities.canMutate;
  }

  get canGrant(): boolean {
    return this.active && this.capabilities.canGrant;
  }

  get hasLoadedSnapshot(): boolean {
    return this.transport.hasLoadedSnapshot;
  }

  updateCapabilities(capabilities: BoardProviderCapabilities): void {
    if (this.active) {
      this.capabilities = capabilities;
    }
  }

  deactivate(): void {
    this.active = false;
  }

  async applyOps(ops: BoardOp[]): Promise<void> {
    if (!this.canMutate) {
      throw new Error("Session dashboard mutation unavailable");
    }
    await this.transport.applyOps(ops);
  }

  async grant(name: string, decision: "granted" | "rejected"): Promise<void> {
    if (!this.canGrant) {
      throw new Error("Session dashboard approval unavailable");
    }
    await this.transport.grant(name, decision);
  }

  async pinWidget(input: BoardPinWidgetInput): Promise<void> {
    if (!this.canMutate || !this.canPinWidgets) {
      throw new Error("Session dashboard widget pinning unavailable");
    }
    await this.transport.pinWidget(input);
  }

  async pinMcpApp(input: BoardPinMcpAppInput): Promise<void> {
    if (!this.canMutate || !this.canPinMcpApps) {
      throw new Error("Session dashboard MCP App pinning unavailable");
    }
    await this.transport.pinMcpApp(input);
  }

  widgetFrameUrl(name: string, revision: number): string {
    return this.transport.widgetFrameUrl(name, revision);
  }

  refreshWidgetFrame(name: string): Promise<void> {
    return this.transport.refreshWidgetFrame(name);
  }

  widgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return this.transport.widgetAppView(name, revision);
  }

  refreshWidgetAppView(name: string, revision: number): Promise<BoardWidgetAppViewState> {
    return this.transport.refreshWidgetAppView(name, revision);
  }
}

const nullProviders = new Map<string, NullProvider>();
const gatewayProviders = new Map<string, { provider: GatewayBoardProvider; consumers: number }>();
export function boardProviderCacheKey(session: BoardGetParams): string {
  const identity = resolveUiConversationIdentity(
    {},
    normalizeDefaultMainSessionAliasForUi(session.sessionKey),
    session.agentId,
  );
  return JSON.stringify([session.agentId ?? identity.agentId, identity.sessionKey]);
}

// Session lookups are read-only: only a lifecycle-owned lease may create and
// subscribe a gateway transport, so hidden panes cannot orphan subscriptions.
export function boardProviderForSession(session: BoardGetParams, available = true): BoardProvider {
  const key = boardProviderCacheKey(session);
  const sessionKey = normalizeDefaultMainSessionAliasForUi(session.sessionKey);
  const gatewayProvider = available ? gatewayProviders.get(key)?.provider : undefined;
  if (gatewayProvider) {
    return gatewayProvider;
  }
  let provider = nullProviders.get(key);
  if (!provider) {
    provider = new NullProvider(sessionKey);
    nullProviders.set(key, provider);
  }
  return provider;
}

export type BoardProviderLease = {
  provider: BoardProvider;
  update: (
    client: BoardGatewayClient,
    connected: boolean,
    capabilities: BoardProviderCapabilities,
  ) => void;
  release: () => void;
};

export function acquireBoardProviderForSession(
  session: BoardGetParams,
  client: BoardGatewayClient,
  connected = true,
  canPinWidgets = true,
  canPinMcpApps = false,
  canMutate = true,
  canGrant = true,
): BoardProviderLease {
  const key = boardProviderCacheKey(session);
  let entry = gatewayProviders.get(key);
  if (!entry) {
    const target = {
      ...session,
      sessionKey: normalizeDefaultMainSessionAliasForUi(session.sessionKey),
    };
    entry = { provider: new GatewayBoardProvider(target, client, connected), consumers: 0 };
    gatewayProviders.set(key, entry);
  } else {
    entry.provider.attachClient(client, connected);
  }
  const scopedProvider = new ScopedGatewayBoardProvider(entry.provider, {
    canPinWidgets,
    canPinMcpApps,
    canMutate,
    canGrant,
  });
  entry.consumers += 1;
  let released = false;
  return {
    provider: scopedProvider,
    update: (nextClient, nextConnected, capabilities) => {
      if (released || gatewayProviders.get(key)?.provider !== entry.provider) {
        return;
      }
      scopedProvider.updateCapabilities(capabilities);
      entry.provider.attachClient(nextClient, nextConnected);
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      scopedProvider.deactivate();
      const current = gatewayProviders.get(key);
      if (!current || current.provider !== entry.provider) {
        return;
      }
      current.consumers -= 1;
      if (current.consumers > 0) {
        return;
      }
      gatewayProviders.delete(key);
      current.provider.dispose();
    },
  };
}
