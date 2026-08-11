import type {
  Context,
  ImageContent,
  ImagesModel,
  Message,
  Model,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@openclaw/llm-core";
import { describe, expectTypeOf, it } from "vitest";
import type {
  MediaContent,
  ModelInputContent,
  ProviderContext,
  ProviderMessage,
  ProviderModel,
  ProviderStreamFunction,
  ProviderUserMessage,
  VideoContent,
} from "./provider-types.js";

describe("provider call types", () => {
  it("keeps video at the provider boundary without widening canonical contracts", () => {
    expectTypeOf<VideoContent>().toEqualTypeOf<Omit<ImageContent, "type"> & { type: "video" }>();
    expectTypeOf<MediaContent>().toEqualTypeOf<ImageContent | VideoContent>();
    expectTypeOf<ModelInputContent>().toEqualTypeOf<TextContent | MediaContent>();
    expectTypeOf<ProviderUserMessage["content"]>().toEqualTypeOf<string | ModelInputContent[]>();
    expectTypeOf<ProviderMessage>().toEqualTypeOf<
      ProviderUserMessage | Exclude<Message, UserMessage>
    >();
    expectTypeOf<ProviderContext["messages"][number]>().toEqualTypeOf<ProviderMessage>();
    expectTypeOf<ProviderModel["input"][number]>().toEqualTypeOf<"text" | "image" | "video">();
    expectTypeOf<Parameters<ProviderStreamFunction>[0]>().toEqualTypeOf<ProviderModel>();
    expectTypeOf<Parameters<ProviderStreamFunction>[1]>().toEqualTypeOf<ProviderContext>();

    expectTypeOf<UserMessage["content"]>().toEqualTypeOf<string | (TextContent | ImageContent)[]>();
    expectTypeOf<Context["messages"][number]>().toEqualTypeOf<Message>();
    expectTypeOf<Model["input"][number]>().toEqualTypeOf<"text" | "image">();
    expectTypeOf<ToolResultMessage["content"][number]>().toEqualTypeOf<
      TextContent | ImageContent
    >();
    expectTypeOf<ImagesModel["input"][number]>().toEqualTypeOf<"text" | "image">();
  });
});
