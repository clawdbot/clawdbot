import {
  createKimiInlineReasoningSanitizer,
  isOllamaCloudKimiModelRef,
} from "./kimi-inline-reasoning.js";
import type { OllamaVisibleContentSanitizer } from "./visible-content-contract.js";

const noopVisibleContentSanitizer: OllamaVisibleContentSanitizer = {
  resolveStreamText(params) {
    return { kind: "visible", text: params.text };
  },
  sanitizeFinalText(text) {
    return text;
  },
};

export function createOllamaVisibleContentSanitizer(
  modelId: string,
): OllamaVisibleContentSanitizer {
  if (isOllamaCloudKimiModelRef(modelId)) {
    return createKimiInlineReasoningSanitizer();
  }
  return noopVisibleContentSanitizer;
}

export function sanitizeOllamaFinalVisibleContent(params: {
  modelId: string;
  text: string;
}): string {
  return createOllamaVisibleContentSanitizer(params.modelId).sanitizeFinalText(params.text);
}
