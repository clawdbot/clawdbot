import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerTelegramMiniAppCommand } from "./src/miniapp/command.js";
import { createTelegramMiniAppLaunchTickets } from "./src/miniapp/launch-ticket.js";
import { registerTelegramMiniAppRoutes } from "./src/miniapp/routes.js";

export function registerTelegramMiniApp(api: OpenClawPluginApi): void {
  const launchTickets = createTelegramMiniAppLaunchTickets();
  registerTelegramMiniAppRoutes(api, launchTickets);
  registerTelegramMiniAppCommand(api, launchTickets);
}
