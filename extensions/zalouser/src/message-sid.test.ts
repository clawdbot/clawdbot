import { describe, expect, it } from "vitest";
import {
  formatZalouserMessageSidFull,
  parseZalouserMessageSidFull,
  resolveZalouserMessageSid,
  resolveZalouserReactionMessageIds,
} from "./message-sid.js";

describe("zalouser message sid helpers", () => {
  it("parses MessageSidFull pairs", () => {
    expect(parseZalouserMessageSidFull("111:222")).toEqual({
      msgId: "111",
      cliMsgId: "222",
    });
    expect(parseZalouserMessageSidFull("111")).toBeNull();
    expect(parseZalouserMessageSidFull(undefined)).toBeNull();
  });

  it("resolves reaction ids from explicit params first", () => {
    expect(
      resolveZalouserReactionMessageIds({
        messageId: "m-1",
        cliMsgId: "c-1",
        currentMessageId: "x:y",
      }),
    ).toEqual({
      msgId: "m-1",
      cliMsgId: "c-1",
    });
  });

  it("resolves reaction ids from current message sid full", () => {
    expect(
      resolveZalouserReactionMessageIds({
        currentMessageId: "m-2:c-2",
      }),
    ).toEqual({
      msgId: "m-2",
      cliMsgId: "c-2",
    });
  });

  it("falls back to duplicated current id when no pair is available", () => {
    expect(
      resolveZalouserReactionMessageIds({
        currentMessageId: "solo",
      }),
    ).toEqual({
      msgId: "solo",
      cliMsgId: "solo",
    });
  });

  it("formats message sid fields for context payload", () => {
    expect(formatZalouserMessageSidFull({ msgId: "1", cliMsgId: "2" })).toBe("1:2");
    expect(formatZalouserMessageSidFull({ msgId: "1" })).toBe("1");
    expect(formatZalouserMessageSidFull({ cliMsgId: "2" })).toBe("2");
    expect(formatZalouserMessageSidFull({})).toBeUndefined();
  });

  it("resolves primary message sid with fallback timestamp", () => {
    expect(resolveZalouserMessageSid({ msgId: "1", cliMsgId: "2", fallback: "t" })).toBe("1");
    expect(resolveZalouserMessageSid({ cliMsgId: "2", fallback: "t" })).toBe("2");
    expect(resolveZalouserMessageSid({ fallback: "t" })).toBe("t");
  });
});
