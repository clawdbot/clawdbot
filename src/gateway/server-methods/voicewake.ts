// Gateway RPC handlers for voice wake phrase configuration.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "../../infra/voicewake.js";
import { normalizeVoiceWakeTriggers } from "../server-utils.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway request handlers for reading and updating voice wake triggers. */
export const voicewakeHandlers: GatewayRequestHandlers = {
  "voicewake.get": async ({ respond }) => {
    try {
      const cfg = await loadVoiceWakeConfig();
      respond(true, { triggers: cfg.triggers });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
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
    try {
      const triggers = normalizeVoiceWakeTriggers(params.triggers);
      // Persist the normalized trigger list before broadcasting so connected
      // nodes and future gateway starts observe the same wake phrases.
      const cfg = await setVoiceWakeTriggers(triggers);
      context.broadcastVoiceWakeChanged(cfg.triggers);
      respond(true, { triggers: cfg.triggers });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
