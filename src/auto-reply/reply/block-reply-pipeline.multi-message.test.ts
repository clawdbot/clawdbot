import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

function blockFor(text: string, assistantMessageIndex: number) {
  return setReplyPayloadMetadata({ text }, { assistantMessageIndex });
}

describe("block reply pipeline multi-assistant-message suppression", () => {
  it("recognizes each fully-streamed message across a multi-message turn", async () => {
    const sent: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        if (payload.text) {
          sent.push(payload.text);
        }
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Alpha one.", 0));
    pipeline.enqueue(blockFor("Alpha two.", 0));
    pipeline.enqueue(blockFor("Beta one.", 1));
    pipeline.enqueue(blockFor("Beta two.", 1));
    await pipeline.flush({ force: true });

    expect(sent).toEqual(["Alpha one.", "Alpha two.", "Beta one.", "Beta two."]);
    expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two." })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "Beta one. Beta two." })).toBe(true);
  });

  it("does not treat one message as covering another message's text", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Alpha one.", 0));
    pipeline.enqueue(blockFor("Alpha two.", 0));
    pipeline.enqueue(blockFor("Beta one.", 1));
    pipeline.enqueue(blockFor("Beta two.", 1));
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two. Beta one. Beta two." })).toBe(
      false,
    );
  });

  it("suppresses a single message split into multiple blocks", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Gamma one.", 0));
    pipeline.enqueue(blockFor("Gamma two.", 0));
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Gamma one. Gamma two." })).toBe(true);
  });
});
