// Line tests cover the record of message ids an inbound quote can point at.
import { describe, expect, it } from "vitest";
import { quotesLineBotMessage, recordLineSentMessages } from "./outbound-message-log.js";

describe("outbound message log", () => {
  it("recognises an id this account sent and nothing else", () => {
    recordLineSentMessages("default", ["sent-1", "sent-2"]);

    expect(quotesLineBotMessage("default", "sent-1")).toBe(true);
    expect(quotesLineBotMessage("default", "sent-2")).toBe(true);
    expect(quotesLineBotMessage("default", "never-sent")).toBe(false);
    expect(quotesLineBotMessage("default", undefined)).toBe(false);
  });

  it("keeps accounts apart so one bot's message never addresses another", () => {
    recordLineSentMessages("work", ["shared-room-message"]);

    expect(quotesLineBotMessage("work", "shared-room-message")).toBe(true);
    expect(quotesLineBotMessage("personal", "shared-room-message")).toBe(false);
  });

  it("forgets the oldest ids once the bound is reached, keeping the newest", () => {
    const overflow = Array.from({ length: 600 }, (_, index) => `bulk-${index}`);
    recordLineSentMessages("bulk", overflow);

    expect(quotesLineBotMessage("bulk", "bulk-0")).toBe(false);
    expect(quotesLineBotMessage("bulk", "bulk-599")).toBe(true);
  });

  it("keeps a quiet account's ids while a busy account fills its own bound", () => {
    recordLineSentMessages("quiet", ["quiet-1"]);
    recordLineSentMessages(
      "busy",
      Array.from({ length: 2000 }, (_, index) => `busy-${index}`),
    );

    expect(quotesLineBotMessage("quiet", "quiet-1")).toBe(true);
    expect(quotesLineBotMessage("busy", "busy-1999")).toBe(true);
    expect(quotesLineBotMessage("busy", "busy-0")).toBe(false);
  });

  it("re-sending an id moves it back out of eviction range", () => {
    recordLineSentMessages("refresh", ["kept"]);
    recordLineSentMessages(
      "refresh",
      Array.from({ length: 499 }, (_, i) => `filler-${i}`),
    );
    recordLineSentMessages("refresh", ["kept"]);
    recordLineSentMessages(
      "refresh",
      Array.from({ length: 400 }, (_, i) => `later-${i}`),
    );

    expect(quotesLineBotMessage("refresh", "kept")).toBe(true);
  });
});
