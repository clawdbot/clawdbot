// Moonshot stream wrapper normalizes Moonshot streamed text and reasoning output.
import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { streamSimple } from "../../stream.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export {
  createMoonshotThinkingWrapper,
  resolveMoonshotThinkingKeep,
  resolveMoonshotThinkingType,
} from "./moonshot-thinking.js";

/** Detects SiliconFlow Pro models that require thinking=null instead of thinking="off". */
export function shouldApplySiliconFlowThinkingOffCompat(params: {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): boolean {
  return (
    params.provider === "siliconflow" &&
    params.thinkingLevel === "off" &&
    params.modelId.startsWith("Pro/")
  );
}

/** Wraps Moonshot-compatible requests to rewrite SiliconFlow thinking-off payloads. */
export function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      // SiliconFlow rejects the string "off" for these models but accepts null.
      if (payloadObj.thinking === "off") {
        payloadObj.thinking = null;
      }
    });
}
