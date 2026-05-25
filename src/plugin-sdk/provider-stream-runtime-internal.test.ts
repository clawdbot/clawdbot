import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPlainTextToolCallPromotionWrapper } from "./provider-stream-runtime-internal.js";

type StreamEvent = { type: string } & Record<string, unknown>;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function createControlledWrappedStream() {
  const source = createAssistantMessageEventStream();
  const baseStream: StreamFn = () => source as ReturnType<StreamFn>;
  const wrapped = createPlainTextToolCallPromotionWrapper(baseStream);
  const stream = wrapped(
    { provider: "test", api: "openai-completions", id: "test-model" } as never,
    {
      messages: [],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    } as never,
    {},
  );
  return { source, stream };
}

async function resolveStream(stream: ReturnType<StreamFn>) {
  return stream instanceof Promise ? await stream : stream;
}

async function nextEvent(
  iterator: AsyncIterator<unknown>,
  label: string,
): Promise<StreamEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 50)),
  ]);
  if (result === "timed out") {
    throw new Error(`timed out waiting for ${label}`);
  }
  expect(result.done).toBe(false);
  return result.value as StreamEvent;
}

describe("createPlainTextToolCallPromotionWrapper", () => {
  it("promotes standalone plain-text tool calls for result consumers", async () => {
    const { source, stream } = createControlledWrappedStream();
    const resultPromise = (await resolveStream(stream)).result();
    const rawToolText = '[tool:read] {"path":"src/index.ts"}';

    source.push({ type: "start", partial: { content: [] } } as never);
    source.push({
      type: "text_delta",
      contentIndex: 0,
      delta: rawToolText,
    } as never);
    source.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: rawToolText }],
        stopReason: "stop",
      },
    } as never);
    source.end();

    const message = requireRecord(await resultPromise, "result message");
    expect(message.stopReason).toBe("toolUse");
    expect(requireRecord((message.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("does not buffer ordinary bracketed text until done", async () => {
    const { source, stream } = createControlledWrappedStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_start",
        contentIndex: 0,
        partial: { content: [{ type: "text", text: "" }] },
      } as never);
      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "[note] keep streaming",
      } as never);

      expect((await nextEvent(iterator, "ordinary bracketed text")).type).toBe("text_start");
    } finally {
      source.push({ type: "done", reason: "stop", message: {} } as never);
      source.end();
      await iterator.return?.();
    }
  });

  it("keeps CR-separated bracketed tool calls buffered for promotion", async () => {
    const { source, stream } = createControlledWrappedStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: '[read]\r{"path":"src/index.ts"}\r[END_TOOL_REQUEST]',
      } as never);
      source.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: '[read]\r{"path":"src/index.ts"}\r[END_TOOL_REQUEST]' },
          ],
          stopReason: "stop",
        },
      } as never);

      const event = await nextEvent(iterator, "promoted CR tool call");
      expect(event.type).toBe("toolcall_start");
    } finally {
      source.end();
      await iterator.return?.();
    }
  });

  it("does not buffer normal final prose until done", async () => {
    const { source, stream } = createControlledWrappedStream();
    const iterator = (await resolveStream(stream))[Symbol.asyncIterator]();

    try {
      source.push({ type: "start", partial: { content: [] } } as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "final answer starts here",
      } as never);

      const event = await nextEvent(iterator, "normal final prose");
      expect(event).toMatchObject({ type: "text_delta", delta: "final answer starts here" });
    } finally {
      source.push({ type: "done", reason: "stop", message: {} } as never);
      source.end();
      await iterator.return?.();
    }
  });
});
