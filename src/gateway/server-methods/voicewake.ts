// Gateway RPC handlers for voice wake phrase configuration.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "../../infra/voicewake.js";
import { normalizeVoiceWakeTriggers } from "../server-utils.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway request handlers for reading and updating voice wake triggers. */
export const voicewakeHandlers: GatewayRequestHandlers = {
  "voicewake.get": async ({ respond }) => {
    await respondUnavailableOnThrow(respond, async () => {
      const cfg = await loadVoiceWakeConfig();
      respond(true, { triggers: cfg.triggers });
    });
  },
  "voicewake.set": async ({ params, respond, context }) => {
    if (!Array.isArray(params.triggers)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voicewake.set requires triggers: string[]"),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const triggers = normalizeVoiceWakeTriggers(params.triggers);
      // Persist the normalized trigger list before broadcasting so connected
      // nodes and future gateway starts observe the same wake phrases.
      const cfg = await setVoiceWakeTriggers(triggers);
      context.broadcastVoiceWakeChanged(cfg.triggers);
      respond(true, { triggers: cfg.triggers });
    });
  },
};
