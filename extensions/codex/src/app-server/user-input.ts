import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type { CodexUserInput } from "./protocol.js";

/** Builds ordered Codex user input for both new turns and same-turn steering. */
export function buildCodexUserInput(
  text: string | undefined,
  images?: EmbeddedRunAttemptParams["images"],
): CodexUserInput[] {
  const imageInputs = (images ?? []).map((image): CodexUserInput => {
    const imageUrl = sanitizeInlineImageDataUrl(`data:${image.mimeType};base64,${image.data}`);
    return imageUrl
      ? { type: "image", url: imageUrl }
      : {
          type: "text",
          text: invalidInlineImageText("codex user input"),
          text_elements: [],
        };
  });
  const textInput: CodexUserInput[] =
    text === undefined ? [] : [{ type: "text", text, text_elements: [] }];
  return [...textInput, ...imageInputs];
}
