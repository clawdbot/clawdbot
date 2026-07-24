import { Value } from "@sinclair/typebox/value";
import {
  executeAiIntelligenceGatewayRequest,
  isAiIntelligenceGatewayEnabled,
} from "../ai-intelligence-runtime.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  AiExecuteParamsSchema,
  AiExecuteResultSchema,
  type AiExecuteParams,
} from "../protocol/schema/ai-intelligence.js";
import type { GatewayRequestHandlers } from "./types.js";

export const aiIntelligenceHandlers: GatewayRequestHandlers = {
  "ai.execute": async ({ params, respond, context }) => {
    if (!isAiIntelligenceGatewayEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "AI Intelligence gateway execution is disabled"),
      );
      return;
    }
    if (!Value.Check(AiExecuteParamsSchema, params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid ai.execute params"));
      return;
    }
    try {
      const result = await executeAiIntelligenceGatewayRequest(params as AiExecuteParams);
      if (!Value.Check(AiExecuteResultSchema, result)) {
        throw new Error("AI Intelligence bridge returned an invalid result");
      }
      respond(true, result, undefined);
    } catch (error) {
      context.logGateway.warn(`AI Intelligence gateway execution failed: ${String(error)}`);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "AI Intelligence execution failed"),
      );
    }
  },
};
