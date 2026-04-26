import {
  loadVoiceWakeRoutingConfig,
  normalizeVoiceWakeRoutingConfig,
  setVoiceWakeRoutingConfig,
  validateVoiceWakeRoutingConfigInput,
} from "../../infra/voicewake-routing.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const voicewakeRoutingHandlers: GatewayRequestHandlers = {
  "voicewake.routing.get": async ({ respond }) => {
    try {
      respond(true, { config: await loadVoiceWakeRoutingConfig() });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "voicewake.routing.set": async ({ params, respond, context }) => {
    if (
      !params ||
      params.config === null ||
      typeof params.config !== "object" ||
      Array.isArray(params.config)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "voicewake.routing.set requires config: object"),
      );
      return;
    }
    const validated = validateVoiceWakeRoutingConfigInput(params.config);
    if (!validated.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, validated.message));
      return;
    }
    try {
      const normalized = normalizeVoiceWakeRoutingConfig(params.config);
      const config = await setVoiceWakeRoutingConfig(normalized);
      context.broadcastVoiceWakeRoutingChanged(config);
      respond(true, { config });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
