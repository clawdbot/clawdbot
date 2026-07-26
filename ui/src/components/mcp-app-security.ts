import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

type McpAppHostCapabilities = ConstructorParameters<typeof AppBridge>[2];
export type McpAppHostSandboxCsp = NonNullable<
  NonNullable<McpAppHostCapabilities["sandbox"]>["csp"]
>;

/** Bubbling event handled by the owning chat pane through its normal send path. */
export const WIDGET_PROMPT_EVENT = "openclaw-widget-prompt";
export type WidgetPromptEventDetail = { text: string };
export const MCP_APP_VIEW_EXPIRED_EVENT = "openclaw-mcp-app-view-expired";

const WIDGET_PROMPT_MAX_CHARS = 4_000;
const WIDGET_PROMPT_RATE_WINDOW_MS = 60_000;
const WIDGET_PROMPT_RATE_MAX = 10;
const WIDGET_PROMPT_RATE_KEYS_MAX = 100;
const widgetPromptTimestampsByKey = new Map<string, number[]>();

function resolveWidgetPromptText(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const text = raw.trim();
  const isHostCommand = text.startsWith("/") || text.startsWith("!");
  if (!text || text.length > WIDGET_PROMPT_MAX_CHARS || isHostCommand) {
    return null;
  }
  return text;
}

function allowWidgetPrompt(key: string, nowMs: number): boolean {
  const cutoff = nowMs - WIDGET_PROMPT_RATE_WINDOW_MS;
  const timestamps = (widgetPromptTimestampsByKey.get(key) ?? []).filter((ts) => ts > cutoff);
  if (
    !widgetPromptTimestampsByKey.has(key) &&
    widgetPromptTimestampsByKey.size >= WIDGET_PROMPT_RATE_KEYS_MAX
  ) {
    const oldest = widgetPromptTimestampsByKey.keys().next().value;
    if (oldest !== undefined) {
      widgetPromptTimestampsByKey.delete(oldest);
    }
  }
  if (timestamps.length >= WIDGET_PROMPT_RATE_MAX) {
    widgetPromptTimestampsByKey.set(key, timestamps);
    return false;
  }
  timestamps.push(nowMs);
  widgetPromptTimestampsByKey.set(key, timestamps);
  return true;
}

function isWidgetFrameInteractable(frame: HTMLIFrameElement): boolean {
  if (!frame.isConnected) {
    return false;
  }
  const visible =
    typeof frame.checkVisibility === "function"
      ? frame.checkVisibility()
      : frame.getClientRects().length > 0;
  if (!visible) {
    return false;
  }
  let active: Element | null = frame.ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active === frame;
}

/**
 * Agent-authored frames may submit only user-focused conversational text.
 * The shared event preserves pane routing and prevents privileged shortcuts.
 */
export function dispatchWidgetPrompt(
  frame: HTMLIFrameElement,
  raw: unknown,
  rateKey: string,
  confirmPrompt?: (text: string) => boolean,
): boolean {
  const text = resolveWidgetPromptText(raw);
  if (
    !text ||
    !isWidgetFrameInteractable(frame) ||
    !allowWidgetPrompt(rateKey, Date.now()) ||
    (confirmPrompt && !confirmPrompt(text))
  ) {
    return false;
  }
  frame.dispatchEvent(
    new CustomEvent<WidgetPromptEventDetail>(WIDGET_PROMPT_EVENT, {
      bubbles: true,
      composed: true,
      detail: { text },
    }),
  );
  return true;
}

export function buildMcpAppHostCapabilities(
  csp?: McpAppHostSandboxCsp,
  supportsMessage = false,
  supportsUpdateModelContext = false,
): McpAppHostCapabilities {
  return {
    openLinks: {},
    serverResources: {},
    serverTools: {},
    sandbox: { csp: csp ?? {} },
    ...(supportsMessage ? { message: { text: {} } } : {}),
    ...(supportsUpdateModelContext ? { updateModelContext: { text: {} } } : {}),
  };
}

export function resolveMcpAppSandboxUrl(
  value: string,
  sandboxPort: number,
  sandboxOrigin: string | undefined,
  gatewayUrl: string,
  hostOrigin: string,
): string {
  return resolveSandboxHostUrl(
    value,
    sandboxPort,
    sandboxOrigin,
    gatewayUrl,
    hostOrigin,
    "MCP App sandbox URL is invalid",
  );
}
