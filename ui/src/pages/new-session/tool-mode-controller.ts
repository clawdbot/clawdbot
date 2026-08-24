import type {
  PluginSessionToolMode,
  PluginsUiDescriptorsResult,
  SessionToolModeSelection,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatComposerToolModeMenuProps } from "../chat/components/chat-composer-tool-mode-menu.ts";
import * as catalog from "./catalog-target.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";

function resolveToolModeRuntimeId(
  place: DraftPlaceState,
  context: ApplicationContext | undefined,
  data: NewSessionRouteData | undefined,
): string {
  if (catalog.isTarget(data)) {
    return data?.catalogId.trim().toLowerCase() || "external";
  }
  return (
    place.modelControl
      .resolveAgentRuntime({ agent: place.selectedAgent(), context })
      ?.id.trim()
      .toLowerCase() ?? "openclaw"
  );
}

export class NewSessionToolModeController {
  modes: PluginSessionToolMode[] = [];
  private client: GatewayBrowserClient | null = null;

  constructor(
    private readonly selectionTarget: {
      toolMode: SessionToolModeSelection | undefined;
      submitting: boolean;
      pendingPlacement: { sessionKey: string };
    },
    private readonly requestUpdate: () => void,
  ) {}

  async synchronize(client: GatewayBrowserClient | null): Promise<void> {
    if (!client || this.client === client) {
      return;
    }
    this.client = client;
    try {
      const result = await client.request<PluginsUiDescriptorsResult>("plugins.uiDescriptors", {});
      if (this.client !== client) {
        return;
      }
      this.modes = result.toolModes;
      const selection = this.selectionTarget.toolMode;
      if (
        selection &&
        !this.modes.some(
          (mode) => mode.pluginId === selection.pluginId && mode.id === selection.modeId,
        )
      ) {
        this.select(undefined);
      } else {
        this.requestUpdate();
      }
    } catch {
      if (this.client === client) {
        this.modes = [];
        this.select(undefined);
      }
    }
  }

  synchronizeGateway(
    gateway: ApplicationContext["gateway"],
    draftGateway: DraftGatewayState,
  ): void {
    draftGateway.synchronize(gateway);
    void this.synchronize(gateway.snapshot.client ?? null);
  }

  reconcile(
    place: DraftPlaceState,
    context: ApplicationContext | undefined,
    data?: NewSessionRouteData,
  ): void {
    const runtimeId = resolveToolModeRuntimeId(place, context, data);
    if (runtimeId !== "openclaw") {
      if (this.selectionTarget.toolMode) {
        this.select(undefined);
      }
      return;
    }
    if (this.modes.length === 0) {
      return;
    }
    const selection = this.selectionTarget.toolMode;
    if (
      selection &&
      this.modes.some(
        (mode) => mode.pluginId === selection.pluginId && mode.id === selection.modeId,
      )
    ) {
      return;
    }
    const defaultMode = this.modes.find((mode) => mode.default === true);
    this.select(
      defaultMode ? { pluginId: defaultMode.pluginId, modeId: defaultMode.id } : undefined,
    );
  }

  menuProps(
    place: DraftPlaceState,
    context: ApplicationContext | undefined,
    data?: NewSessionRouteData,
  ): ChatComposerToolModeMenuProps | undefined {
    if (this.modes.length === 0) {
      return undefined;
    }
    const runtimeId = resolveToolModeRuntimeId(place, context, data);
    return {
      modes: this.modes,
      selected: this.selectionTarget.toolMode ?? null,
      active: null,
      runtimeId,
      disabled:
        this.selectionTarget.submitting ||
        Boolean(this.selectionTarget.pendingPlacement.sessionKey),
      onSelect: (selection) => this.select(selection),
    };
  }

  private select(selection: SessionToolModeSelection | undefined): void {
    const current = this.selectionTarget.toolMode;
    if (current?.pluginId === selection?.pluginId && current?.modeId === selection?.modeId) {
      return;
    }
    this.selectionTarget.toolMode = selection;
    this.requestUpdate();
  }
}
