// Line tests cover the record of what an inbound quote can point at.
import { describe, expect, it } from "vitest";
import {
  recordLineAgentVisibleMessage,
  recordLineSentMessages,
  resolveLineQuotedMessage,
} from "./quoted-messages.js";

describe("quoted message store", () => {
  it("recognizes an id this account sent and nothing else", () => {
    recordLineSentMessages("default", ["sent-1", "sent-2"]);

    expect(resolveLineQuotedMessage("default", "sent-1")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("default", "sent-2")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("default", "never-sent")).toBeUndefined();
    expect(resolveLineQuotedMessage("default", undefined)).toBeUndefined();
  });

  it("answers a quote of a received message with its text and its author", () => {
    recordLineAgentVisibleMessage("default", {
      id: "peer-1",
      body: "the deploy key is in 1Password",
      senderId: "U-teammate",
    });

    expect(resolveLineQuotedMessage("default", "peer-1")).toEqual({
      fromBot: false,
      body: "the deploy key is in 1Password",
      senderId: "U-teammate",
    });
  });

  it("keeps a received message that carried no text", () => {
    recordLineAgentVisibleMessage("default", { id: "photo-1", body: "<image>" });

    expect(resolveLineQuotedMessage("default", "photo-1")).toEqual({
      fromBot: false,
      body: "<image>",
    });
  });

  it("bounds a retained body so one long message cannot dominate the prompt", () => {
    recordLineAgentVisibleMessage("default", { id: "long-1", body: "x".repeat(5000) });

    expect(resolveLineQuotedMessage("default", "long-1")?.body).toHaveLength(2000);
  });

  it("keeps accounts apart so one bot's message never addresses another", () => {
    recordLineSentMessages("work", ["shared-room-message"]);

    expect(resolveLineQuotedMessage("work", "shared-room-message")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("personal", "shared-room-message")).toBeUndefined();
  });

  it("forgets the oldest ids once the bound is reached, keeping the newest", () => {
    const overflow = Array.from({ length: 600 }, (_, index) => `bulk-${index}`);
    recordLineSentMessages("bulk", overflow);

    expect(resolveLineQuotedMessage("bulk", "bulk-0")).toBeUndefined();
    expect(resolveLineQuotedMessage("bulk", "bulk-599")).toEqual({ fromBot: true });
  });

  it("keeps a quiet account's ids while a busy account fills its own bound", () => {
    recordLineSentMessages("quiet", ["quiet-1"]);
    recordLineSentMessages(
      "busy",
      Array.from({ length: 2000 }, (_, index) => `busy-${index}`),
    );

    expect(resolveLineQuotedMessage("quiet", "quiet-1")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("busy", "busy-1999")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("busy", "busy-0")).toBeUndefined();
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

    expect(resolveLineQuotedMessage("refresh", "kept")).toEqual({ fromBot: true });
  });
});
