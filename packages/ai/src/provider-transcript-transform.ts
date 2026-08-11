import type {
  Api,
  AssistantMessage,
  ModelInputContent,
  ProviderMessage,
  ProviderModel,
  VideoContent,
} from "./provider-types.js";
import { transformMessages } from "./transcript-transform.js";
import type { Message, Model as CanonicalModel } from "./types.js";

const IMAGE_OMISSION = "(image omitted: model does not support images)";
const VIDEO_OMISSION = "(video omitted: provider does not support video input)";

function projectUserMediaForTransport(
  content: ModelInputContent[],
  supportsImages: boolean,
): Exclude<ModelInputContent, VideoContent>[] {
  const result: Exclude<ModelInputContent, VideoContent>[] = [];
  for (const block of content) {
    if (block.type === "text" || (block.type === "image" && supportsImages)) {
      result.push(block);
      continue;
    }
    const text = block.type === "video" ? VIDEO_OMISSION : IMAGE_OMISSION;
    const previous = result.at(-1);
    if (block.data.trim() && !(previous?.type === "text" && previous.text === text)) {
      result.push({ type: "text", text });
    }
  }
  return result;
}

export function transformProviderMessages<TApi extends Api>(
  messages: ProviderMessage[],
  model: ProviderModel<TApi>,
  normalizeToolCallId?: (
    id: string,
    model: CanonicalModel<TApi>,
    source: AssistantMessage,
  ) => string,
): Message[] {
  const target: CanonicalModel<TApi> = {
    ...model,
    input: model.input.filter((type): type is "text" | "image" => type !== "video"),
  };
  return transformMessages(
    messages.map((message): Message => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return message as Message;
      }
      return Object.assign({}, message, {
        content: projectUserMediaForTransport(message.content, model.input.includes("image")),
      }) as Extract<Message, { role: "user" }>;
    }),
    target,
    normalizeToolCallId,
  );
}
