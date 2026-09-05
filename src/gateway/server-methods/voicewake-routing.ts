// Gateway RPC handlers for voice wake routing configuration.
import { loadVoiceWakeRoutingConfig } from "../../infra/voicewake-routing.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway request handlers for reading voice wake routing. */
export const voicewakeRoutingHandlers: GatewayRequestHandlers = {
  "voicewake.routing.get": async ({ respond }) => {
    respond(true, { config: await loadVoiceWakeRoutingConfig() });
  },
};
