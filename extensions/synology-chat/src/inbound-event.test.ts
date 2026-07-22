import { describe, expect, it } from "vitest";
import {
  chunkSynologyChatReply,
  SYNOLOGY_CHAT_MAX_MESSAGE_CHARS,
} from "./inbound-event.js";

describe("chunkSynologyChatReply (#112041)", () => {
  it("splits a reply over the Synology char limit into bounded chunks", () => {
    const long = "word ".repeat(3000).trim();
    const chunks = chunkSynologyChatReply(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SYNOLOGY_CHAT_MAX_MESSAGE_CHARS);
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("keeps a reply within the limit as a single chunk", () => {
    expect(chunkSynologyChatReply("hello world")).toEqual(["hello world"]);
  });
});
