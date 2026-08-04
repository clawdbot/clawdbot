import type {
  CopilotArchiveEntry,
  CopilotPanelBindingRegistry,
} from "./copilot-session-registry.js";
import type { BrowserCopilotBinding } from "./panel-core.js";

export const PANEL_PATH: string;

export function resolveSidePanelTabId(
  chromeApi: unknown,
  port: unknown,
  panelBindings: Pick<CopilotPanelBindingRegistry, "resolve">,
): Promise<number>;

export function archiveCopilotSession(
  gateway: {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  },
  entry: CopilotArchiveEntry,
): Promise<void>;

export function selectCopilotPanelState(options: {
  paired: boolean;
  shared: boolean;
  abortPending: boolean;
  gatewayState: string;
}): string;

export function sessionKeyFromEvent(event: unknown): string | null;
export function resolveBindingTarget(config: {
  relayUrl: string;
  gatewayUrl: string;
}): BrowserCopilotBinding["target"];
export function safeTabLabel(tab: { url?: string }): string;
