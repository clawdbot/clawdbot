import type * as Llm from "@openclaw/llm-core";
export type * from "./types.js";

export type VideoContent = Omit<Llm.ImageContent, "type"> & { type: "video" };
export type MediaContent = Llm.ImageContent | VideoContent;
export type ModelInputContent = Llm.TextContent | MediaContent;
export type ProviderUserMessage = Omit<Llm.UserMessage, "content"> & {
  content: string | ModelInputContent[];
};
export type ProviderMessage = ProviderUserMessage | Llm.AssistantMessage | Llm.ToolResultMessage;
export type ProviderContext = Omit<Llm.Context, "messages"> & { messages: ProviderMessage[] };
export type ProviderModel<TApi extends Llm.Api = Llm.Api> = Omit<Llm.Model<TApi>, "input"> & {
  input: ModelInputContent["type"][];
};
export type ProviderStreamFunction<
  TApi extends Llm.Api = Llm.Api,
  TOptions extends Llm.StreamOptions = Llm.StreamOptions,
> = (
  model: ProviderModel<TApi>,
  context: ProviderContext,
  options?: TOptions,
) => Llm.AssistantMessageEventStreamContract;
export type {
  ProviderContext as Context,
  ProviderMessage as Message,
  ProviderModel as Model,
  ProviderStreamFunction as StreamFunction,
};
