import { McpAppView } from "./mcp-app-view.ts";

export function registerMcpAppView(): void {
  if (!customElements.get("mcp-app-view")) {
    customElements.define("mcp-app-view", McpAppView);
  }
}

registerMcpAppView();
