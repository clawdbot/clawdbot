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
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  PROVIDER_CONTEXT_HANDOFF,
  resolveProviderContext,
  type ProviderContextHandoff,
  type ProviderStreamOptions,
  type MediaContent,
  type ModelInputContent,
  type ProviderContext,
  type ProviderMessage,
  type ProviderModel,
  type ProviderStreamFunction,
  type ProviderUserMessage,
  type VideoContent,
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
    expectTypeOf<Parameters<ProviderStreamFunction>[2]>().toEqualTypeOf<
      ProviderStreamOptions | undefined
    >();
    expectTypeOf<ProviderStreamOptions[typeof PROVIDER_CONTEXT_HANDOFF]>().toEqualTypeOf<
      ProviderContextHandoff | undefined
    >();
    expectTypeOf<Parameters<ProviderContextHandoff>>().toEqualTypeOf<[]>();

    expectTypeOf<UserMessage["content"]>().toEqualTypeOf<string | (TextContent | ImageContent)[]>();
    expectTypeOf<Context["messages"][number]>().toEqualTypeOf<Message>();
    expectTypeOf<Model["input"][number]>().toEqualTypeOf<"text" | "image">();
    expectTypeOf<ToolResultMessage["content"][number]>().toEqualTypeOf<
      TextContent | ImageContent
    >();
    expectTypeOf<ImagesModel["input"][number]>().toEqualTypeOf<"text" | "image">();
  });

  it("projects canonical context unless a provider handoff is present", async () => {
    const context = { systemPrompt: "system", messages: [], tools: [] };
    await expect(resolveProviderContext(context)).resolves.toBe(context);

    const resolved = { ...context, messages: [] };
    const handoff = vi.fn(async () => resolved);
    await expect(
      resolveProviderContext(context, { [PROVIDER_CONTEXT_HANDOFF]: handoff }),
    ).resolves.toBe(resolved);
    expect(handoff).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledWith();
  });
});
