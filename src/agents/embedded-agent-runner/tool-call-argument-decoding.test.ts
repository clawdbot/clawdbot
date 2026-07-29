// Tool-call argument decoding tests cover HTML entity repair for model-emitted
// tool arguments without corrupting invalid numeric entities.
import { describe, expect, it } from "vitest";
import { createHtmlEntityToolCallArgumentDecodingWrapper } from "./tool-call-argument-decoding.js";

describe("createHtmlEntityToolCallArgumentDecodingWrapper", () => {
  type DecodedMessage = { content: Array<{ arguments: Record<string, unknown> }> };

  const buildSharedArgumentsAssistant = (
    args: Record<string, unknown> = { content: "&amp;amp;" },
  ) => {
    const toolCall = {
      type: "toolCall" as const,
      id: "call_1",
      name: "write",
      arguments: args,
    };
    const assistant = { role: "assistant" as const, content: [toolCall] };
    const events = [
      { type: "toolcall_end", contentIndex: 0, toolCall, partial: assistant },
      { type: "done", reason: "toolUse", message: assistant },
    ];
    const baseStreamFn = (() => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
      async result() {
        return assistant;
      },
    })) as never;
    return { assistant, baseStreamFn };
  };

  const drive = async (baseStreamFn: never): Promise<DecodedMessage> => {
    const wrapped = createHtmlEntityToolCallArgumentDecodingWrapper(baseStreamFn);
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      [Symbol.asyncIterator](): AsyncIterator<unknown>;
      result(): Promise<DecodedMessage>;
    };
    for await (const event of stream as AsyncIterable<unknown>) {
      void event;
    }
    return stream.result();
  };

  it("decodes nested valid entities while preserving primitive and invalid numeric arguments", async () => {
    const { baseStreamFn } = buildSharedArgumentsAssistant({
      query: "Rock &amp; Roll &#65; &#39;ok&#39; &#x27;hex&#x27;",
      emoji: "ok &#x1F600;",
      args: ["--flag=&quot;value&quot;", "&lt;input&gt;", 42, true, null],
      nested: { deep: "a &amp; b &mdash; &copy;" },
      invalid: "bad &#x110000; and &#9999999999; and &#xD800; and &#55296;",
    });

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments).toEqual({
      query: "Rock & Roll A 'ok' 'hex'",
      emoji: "ok 😀",
      args: ['--flag="value"', "<input>", 42, true, null],
      nested: { deep: "a & b — ©" },
      invalid: "bad &#x110000; and &#9999999999; and &#xD800; and &#55296;",
    });
  });

  it("decodes a shared tool-call arguments object exactly once, keyed by object identity, across its partial, message, and result()", async () => {
    const { baseStreamFn } = buildSharedArgumentsAssistant();

    const finalMessage = await drive(baseStreamFn);

    expect(finalMessage.content[0]?.arguments.content).toBe("&amp;");
  });

  it("decodes the same arguments object once even when it flows through two independent wrapper invocations (the guard spans wrapper instances, not a single stream)", async () => {
    const { assistant, baseStreamFn } = buildSharedArgumentsAssistant();
    const secondStreamFn = (() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "toolUse", message: assistant };
      },
      async result() {
        return assistant;
      },
    })) as never;

    const first = await drive(baseStreamFn);
    const second = await drive(secondStreamFn);

    expect(first.content[0]?.arguments.content).toBe("&amp;");
    expect(second.content[0]?.arguments.content).toBe("&amp;");
  });
});
