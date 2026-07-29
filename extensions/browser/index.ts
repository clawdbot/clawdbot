/**
 * Browser plugin entry. It wires the browser tool, gateway request handler,
 * node-host command, services, reload policy, and security audit collectors.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  browserPluginNodeHostCommands,
  browserPluginReload,
  browserSecurityAuditCollectors,
  registerBrowserPlugin,
} from "./plugin-registration.js";

/** Main Browser plugin entry for runtime registration. */
export default definePluginEntry({
  id: "browser",
  name: "Browser",
  description: "Default browser tool plugin",
  reload: browserPluginReload,
  nodeHostCommands: browserPluginNodeHostCommands,
  securityAuditCollectors: [...browserSecurityAuditCollectors],
  register: registerBrowserPlugin,
});
