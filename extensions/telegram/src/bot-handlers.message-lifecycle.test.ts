import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createTelegramMessageLifecycleRuntime } from "./bot-handlers.message-lifecycle.runtime.js";

function message(fields: Record<string, unknown>): Message {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 42, type: "private", first_name: "Ada" },
    from: { id: 42, is_bot: false, first_name: "Ada" },
    ...fields,
  } as unknown as Message;
}

describe("Telegram ambient transcript media text", () => {
  const runtime = createTelegramMessageLifecycleRuntime({
    accountId: "default",
    runtime: { log: () => {}, error: () => {}, exit: () => {} } as never,
  });

  it("renders native media kinds for captionless transcript lines", () => {
    const body = runtime.formatTelegramAmbientTranscriptBody([
      message({
        message_id: 7,
        photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
      }),
    ]);

    expect(body).toBe("#7 Ada: <media:image>");
  });

  it("preserves captions instead of appending media text", () => {
    const body = runtime.formatTelegramAmbientTranscriptBody([
      message({ message_id: 8, caption: "diagram", document: { file_id: "doc-1" } }),
    ]);

    expect(body).toBe("#8 Ada: diagram");
  });

  it("uses the formatter attachment fallback for media-less empty messages", () => {
    const body = runtime.formatTelegramAmbientTranscriptBody([message({ message_id: 9 })]);

    expect(body).toBe("#9 Ada: <media:attachment>");
  });
});
