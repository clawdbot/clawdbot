import type { EasyInputMessage } from "openai/resources/responses/responses.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  responsesPromptObserver,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

type ResponsesPromptRequest = { instructions?: unknown; input?: unknown };
type ResponsesPromptMetadata = Pick<ResponsesPromptObservation, "egress" | "payloadVariant">;

function readFinalResponsesPrompt(
  request: ResponsesPromptRequest,
): [ResponsesPromptObservation["promptSource"], string] {
  if (typeof request.instructions === "string") {
    return ["instructions", request.instructions] as const;
  }
  const input = Array.isArray(request.input) ? request.input : [];
  const message = input.find((item) => {
    const role = (item as EasyInputMessage).role;
    return role === "developer" || role === "system";
  }) as EasyInputMessage | undefined;
  if (!message) {
    return ["missing", ""] as const;
  }
  const content = message.content;
  const observedPrompt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join("")
        : "";
  return [
    message.role === "developer" ? "input.developer" : "input.system",
    observedPrompt,
  ] as const;
}

export function createResponsesPromptEgressObserver(
  options: object | undefined,
  assembledPrompt: string | undefined,
) {
  const observer = options ? responsesPromptObserver.get(options) : undefined;
  if (!observer) {
    return undefined;
  }
  const expectedPrompt = sanitizeTransportPayloadText(
    stripSystemPromptCacheBoundary(assembledPrompt ?? ""),
  );
  return (request: ResponsesPromptRequest, metadata: ResponsesPromptMetadata) => {
    const [promptSource, observedPrompt] = readFinalResponsesPrompt(request);
    observer({
      ...metadata,
      promptSource,
      expectedChars: expectedPrompt.length,
      observedChars: observedPrompt.length,
      matchesAssembledPrompt: promptSource !== "missing" && observedPrompt === expectedPrompt,
    });
  };
}
