import { McpAppView } from "./mcp-app-view.ts";

if (!customElements.get("mcp-app-view")) {
  customElements.define("mcp-app-view", McpAppView);
}
