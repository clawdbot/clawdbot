import type { Part } from "@google/genai";
import type { ProviderContext, ProviderModel, VideoContent } from "../provider-types.js";
import {
  coerceTransportToolCallArguments,
  sanitizeTransportPayloadText,
} from "../transports/transport-stream-shared.js";
import type { Tool } from "../types.js";
import { sortPromptCacheToolsByName } from "../utils/prompt-cache-stability.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  describeToolResultMediaPlaceholder,
  extractToolResultText,
  isImageWithMediaPayload,
} from "./tool-result-text.js";

type GoogleContentPart = Part & Record<string, unknown>;
type GoogleContent = { role: string; parts: GoogleContentPart[] };
const GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP = "skip_thought_signature_validator";

// SDK history preserves bytes; managed replay also trims and rejects malformed padding.
function resolveThoughtSignature(value: string | undefined): string | undefined {
  return value && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : undefined;
}

function stableStringifyGoogleToolCallValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyGoogleToolCallValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringifyGoogleToolCallValue(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeGeminiThoughtSignature(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)
    ? trimmed
    : undefined;
}

function toolCallThoughtSignatureReplayKey(
  id: string,
  name: string,
  args: Record<string, unknown>,
): string {
  return [id, name, stableStringifyGoogleToolCallValue(args)].join("\u0000");
}

export function requiresGoogleToolCallId(modelId: string): boolean {
  return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/(?:^|\/)gemini(?:-live)?-(\d+)/);
  if (!match) {
    return undefined;
  }
  const majorVersion = match.at(1);
  return majorVersion === undefined ? undefined : Number.parseInt(majorVersion, 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  if (geminiMajorVersion !== undefined) {
    return geminiMajorVersion >= 3;
  }
  return true;
}

/** Project a prepared transcript; route repair and trusted video admission remain caller-owned. */
export function projectGoogleMessages(params: {
  model: Pick<ProviderModel, "id" | "api" | "provider" | "input">;
  messages: ProviderContext["messages"];
  replay: "signed-parts" | "managed";
  requiresToolCallSignature: boolean;
  videoPart?: (video: VideoContent) => GoogleContentPart;
}): GoogleContent[] {
  const { model, messages: transformedMessages } = params;
  const managed = params.replay === "managed";
  const sanitizeText = managed ? sanitizeTransportPayloadText : sanitizeSurrogates;
  const signature = managed ? sanitizeGeminiThoughtSignature : resolveThoughtSignature;
  const replaySignatures = new Map<string, string>();
  const contents: GoogleContent[] = [];
  // Parallel calls need one immediate function-response turn. Gemini < 3 images cannot
  // live inside functionResponse, so hold them until the consecutive result run ends.
  const pendingToolResultImageTurns: GoogleContent[] = [];
  const sameRouteToolCallIds = new Set<string>();
  let activeToolResultParts: GoogleContentPart[] | undefined;
  const flushToolResultRun = (): void => {
    contents.push(...pendingToolResultImageTurns);
    pendingToolResultImageTurns.length = 0;
    activeToolResultParts = undefined;
  };

  for (const msg of transformedMessages) {
    if (msg.role !== "toolResult") {
      flushToolResultRun();
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: sanitizeText(msg.content) || " " }],
        });
      } else {
        const parts: GoogleContentPart[] = msg.content.map((item) => {
          if (item.type === "text") {
            return { text: sanitizeText(item.text) || " " };
          }
          if (managed && item.type === "video") {
            return (
              params.videoPart?.(item) ?? { text: "(video omitted: native video slot unavailable)" }
            );
          }
          return {
            inlineData: {
              mimeType: item.mimeType,
              data: item.data,
            },
          };
        });
        const visibleParts =
          managed && !model.input.includes("image")
            ? parts.filter((part) => !part.inlineData)
            : parts;
        if (visibleParts.length === 0) {
          visibleParts.push({ text: " " });
        }
        contents.push({
          role: "user",
          parts: visibleParts,
        });
      }
    } else if (msg.role === "assistant") {
      const parts: GoogleContentPart[] = [];
      let sawFunctionCall = false;
      const nextReplaySignatures = new Map<string, string>();
      const isSameProviderAndModel =
        msg.provider === model.provider && msg.api === model.api && msg.model === model.id;

      for (const block of msg.content) {
        if (block.type === "text") {
          const thoughtSignature = isSameProviderAndModel
            ? signature(block.textSignature)
            : undefined;
          if ((!block.text || block.text.trim() === "") && (managed || !thoughtSignature)) {
            continue;
          }
          parts.push({
            text: sanitizeText(block.text),
            ...(thoughtSignature && { thoughtSignature }),
          });
        } else if (block.type === "thinking") {
          const thoughtSignature = isSameProviderAndModel
            ? signature(block.thinkingSignature)
            : undefined;
          if ((!block.thinking || block.thinking.trim() === "") && (managed || !thoughtSignature)) {
            continue;
          }
          if (isSameProviderAndModel) {
            parts.push({
              thought: true,
              text: sanitizeText(block.thinking),
              ...(thoughtSignature && { thoughtSignature }),
            });
          } else {
            parts.push({
              text: sanitizeText(block.thinking),
            });
          }
        } else if (block.type === "toolCall") {
          if (isSameProviderAndModel && (managed || model.provider !== "google-gemini-cli")) {
            sameRouteToolCallIds.add(block.id);
          }
          const args = coerceTransportToolCallArguments(block.arguments);
          const ownSignature = isSameProviderAndModel
            ? signature(block.thoughtSignature)
            : undefined;
          // Keys serve managed signature recording or a possible earlier-turn replay lookup.
          const replayKey =
            managed &&
            (ownSignature ||
              (params.requiresToolCallSignature &&
                isSameProviderAndModel &&
                replaySignatures.size > 0))
              ? toolCallThoughtSignatureReplayKey(block.id, block.name, args)
              : "";
          if (managed && ownSignature) {
            nextReplaySignatures.set(replayKey, ownSignature);
          }
          const thoughtSignature =
            ownSignature ??
            (managed && params.requiresToolCallSignature && isSameProviderAndModel
              ? replaySignatures.get(replayKey)
              : undefined) ??
            (params.requiresToolCallSignature && (managed || !sawFunctionCall)
              ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP
              : undefined);
          sawFunctionCall = true;
          const part: GoogleContentPart = {
            functionCall: {
              name: block.name,
              args,
              ...((managed ? isSameProviderAndModel : sameRouteToolCallIds.has(block.id)) ||
              requiresGoogleToolCallId(model.id)
                ? { id: block.id }
                : {}),
            },
            ...(thoughtSignature && { thoughtSignature }),
          };
          parts.push(part);
        }
      }

      for (const [key, value] of nextReplaySignatures) {
        replaySignatures.set(key, value);
      }
      if (parts.length === 0) {
        continue;
      }
      contents.push({
        role: "model",
        parts,
      });
    } else if (msg.role === "toolResult") {
      const textResult = extractToolResultText(msg.content);
      const imageContent = model.input.includes("image")
        ? msg.content.filter((item): item is Extract<typeof item, { type: "image" }> =>
            managed
              ? item.type === "image" && describeToolResultMediaPlaceholder([item]) !== undefined
              : isImageWithMediaPayload(item),
          )
        : [];

      const hasText = textResult.length > 0;
      const hasImages = imageContent.length > 0;
      const mediaPlaceholder = describeToolResultMediaPlaceholder(msg.content);

      const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

      // Use "output" key for success, "error" key for errors as per SDK documentation
      const responseValue = hasText ? sanitizeText(textResult) : (mediaPlaceholder ?? "");

      const imageParts: GoogleContentPart[] = imageContent.map((imageBlock) => ({
        inlineData: {
          mimeType: imageBlock.mimeType,
          data: imageBlock.data,
        },
      }));

      const includeId =
        sameRouteToolCallIds.has(msg.toolCallId) || requiresGoogleToolCallId(model.id);
      const functionResponsePart: GoogleContentPart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
          ...(includeId ? { id: msg.toolCallId } : {}),
        },
      };

      // Cloud Code Assist API requires all function responses to be in a single user turn.
      if (activeToolResultParts) {
        activeToolResultParts.push(functionResponsePart);
      } else {
        activeToolResultParts = [functionResponsePart];
        contents.push({
          role: "user",
          parts: activeToolResultParts,
        });
      }

      // For Gemini < 3, add images in a separate user message
      if (hasImages && !modelSupportsMultimodalFunctionResponse) {
        pendingToolResultImageTurns.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts],
        });
      }
    }
  }

  flushToolResultRun();
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: " " }] });
  }
  return contents;
}

/**
 * Convert tools to Gemini function declarations format.
 * @internal Directly tested provider implementation detail.
 */
export function convertGoogleTools(
  tools: Tool[],
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: sortPromptCacheToolsByName(tools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}
