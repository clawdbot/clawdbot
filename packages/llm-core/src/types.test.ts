import { describe, expectTypeOf, it } from "vitest";
import type {
  ImageContent,
  ImagesModel,
  MediaContent,
  Model,
  ModelInputContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
  VideoContent,
} from "./types.js";

describe("model input content types", () => {
  it("keeps video on user/model input without widening image-only contracts", () => {
    expectTypeOf<VideoContent["type"]>().toEqualTypeOf<"video">();
    expectTypeOf<VideoContent["data"]>().toEqualTypeOf<string>();
    expectTypeOf<VideoContent["mimeType"]>().toEqualTypeOf<string>();
    expectTypeOf<MediaContent>().toEqualTypeOf<ImageContent | VideoContent>();
    expectTypeOf<ModelInputContent>().toEqualTypeOf<TextContent | MediaContent>();
    expectTypeOf<UserMessage["content"]>().toEqualTypeOf<string | ModelInputContent[]>();
    expectTypeOf<Model["input"][number]>().toEqualTypeOf<ModelInputContent["type"]>();

    expectTypeOf<ToolResultMessage["content"][number]>().toEqualTypeOf<
      TextContent | ImageContent
    >();
    expectTypeOf<VideoContent>().not.toMatchTypeOf<ToolResultMessage["content"][number]>();
    expectTypeOf<ImagesModel["input"][number]>().toEqualTypeOf<"text" | "image">();
    expectTypeOf<VideoContent["type"]>().not.toMatchTypeOf<ImagesModel["input"][number]>();
  });
});
