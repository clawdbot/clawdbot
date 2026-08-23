import { peekSessionMcpRuntime } from "../agents/agent-bundle-mcp-runtime.js";
import type { McpAppChannelView } from "../agents/mcp-ui-resource.js";
import { getMcpAppViewLease } from "../agents/mcp-ui-resource.js";
import type { MessagePresentation } from "../interactive/payload.js";
import { getMcpAppChannelOrigin } from "./mcp-app-channel-origin.js";
import { createMcpAppStandaloneTicket } from "./mcp-app-standalone.js";

/** Mint one short-lived launch action only after the final reply route is known. */
export function materializeMcpAppChannelPresentation(params: {
  sessionKey: string;
  view: McpAppChannelView;
  nowMs?: number;
}): MessagePresentation | undefined {
  const origin = getMcpAppChannelOrigin();
  if (!origin) {
    return undefined;
  }
  const runtime = peekSessionMcpRuntime({ sessionKey: params.sessionKey });
  if (!runtime || runtime.mcpAppsEnabled !== true) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  const view = getMcpAppViewLease(params.view.viewId, runtime);
  if (!view || view.expiresAtMs <= nowMs) {
    return undefined;
  }
  const ticket = createMcpAppStandaloneTicket({
    sessionKey: params.sessionKey,
    view,
    nowMs,
  });
  if (!ticket) {
    return undefined;
  }
  return {
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: "Open app",
            action: {
              type: "web-app",
              url: new URL(ticket.url, origin.origin).href,
            },
          },
        ],
      },
    ],
  };
}
