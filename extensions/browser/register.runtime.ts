/**
 * Browser runtime registration barrel. Node host commands and plugin
 * registration lazy-load these exports when browser runtime behavior is needed.
 */
export { createBrowserTool, prepareBrowserStewardToolParams } from "./src/browser-tool.js";
export { handleBrowserGatewayRequest } from "./src/gateway/browser-request.js";
export { runBrowserProxyCommand } from "./src/node-host/invoke-browser.js";
export { createBrowserPluginService } from "./src/plugin-service.js";
export { stopBrowserControlService } from "./src/control-service.js";
export { collectBrowserSecurityAuditFindings } from "./src/security-audit.js";
