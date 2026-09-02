import {
  appendRuntimeImageHistory,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type { CodexUserInput } from "./protocol.js";

/** Builds ordered Codex user input for both new turns and same-turn steering. */
export function buildCodexUserInput(
  text: string | undefined,
  images?: EmbeddedRunAttemptParams["images"],
): CodexUserInput[] {
  const acceptedImages: NonNullable<EmbeddedRunAttemptParams["images"]> = [];
  const imageInputs = (images ?? []).map((image): CodexUserInput => {
    const imageUrl = sanitizeInlineImageDataUrl(`data:${image.mimeType};base64,${image.data}`);
    if (imageUrl) {
      acceptedImages.push(image);
      return { type: "image", url: imageUrl };
    }
    return {
      type: "text",
      text: invalidInlineImageText("codex user input"),
      text_elements: [],
    };
  });
  const prompt = appendRuntimeImageHistory(text ?? "", acceptedImages);
  const textInput: CodexUserInput[] =
    text === undefined && !prompt ? [] : [{ type: "text", text: prompt, text_elements: [] }];
  return [...textInput, ...imageInputs];
}
