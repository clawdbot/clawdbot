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

    expect(resolveLineQuotedMessage("default", "sent-1", "C-room")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("default", "sent-2", "C-room")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("default", "never-sent", "C-room")).toBeUndefined();
    expect(resolveLineQuotedMessage("default", undefined, "C-room")).toBeUndefined();
  });

  it("answers a quote of a received message with its text and its author", () => {
    recordLineAgentVisibleMessage("default", {
      id: "peer-1",
      conversationId: "C-room",
      body: "the deploy key is in 1Password",
      senderId: "U-teammate",
    });

    expect(resolveLineQuotedMessage("default", "peer-1", "C-room")).toEqual({
      fromBot: false,
      body: "the deploy key is in 1Password",
      senderId: "U-teammate",
    });
  });

  it("keeps a received message that carried no text", () => {
    recordLineAgentVisibleMessage("default", {
      id: "photo-1",
      conversationId: "C-room",
      body: "<image>",
    });

    expect(resolveLineQuotedMessage("default", "photo-1", "C-room")).toEqual({
      fromBot: false,
      body: "<image>",
    });
  });

  it("bounds a retained body at the platform text limit", () => {
    recordLineAgentVisibleMessage("default", {
      id: "long-1",
      conversationId: "C-room",
      body: "x".repeat(6000),
    });

    expect(resolveLineQuotedMessage("default", "long-1", "C-room")?.body).toHaveLength(5000);
  });

  it("keeps a long body whole for the prompt layer to shorten", () => {
    recordLineAgentVisibleMessage("default", {
      id: "long-2",
      conversationId: "C-room",
      body: "y".repeat(3000),
    });

    // Cutting below the prompt's own 2000-character cap here would silently
    // replace its head-and-tail form, which keeps the end of a long quote.
    expect(resolveLineQuotedMessage("default", "long-2", "C-room")?.body).toBe("y".repeat(3000));
  });

  it("keeps accounts apart so one bot's message never addresses another", () => {
    recordLineSentMessages("work", ["shared-room-message"]);

    expect(resolveLineQuotedMessage("work", "shared-room-message", "C-room")).toEqual({
      fromBot: true,
    });
    expect(resolveLineQuotedMessage("personal", "shared-room-message", "C-room")).toBeUndefined();
  });

  it("forgets the oldest ids once the bound is reached, keeping the newest", () => {
    const overflow = Array.from({ length: 600 }, (_, index) => `bulk-${index}`);
    recordLineSentMessages("bulk", overflow);

    expect(resolveLineQuotedMessage("bulk", "bulk-0", "C-room")).toBeUndefined();
    expect(resolveLineQuotedMessage("bulk", "bulk-599", "C-room")).toEqual({ fromBot: true });
  });

  it("keeps a quiet account's ids while a busy account fills its own bound", () => {
    recordLineSentMessages("quiet", ["quiet-1"]);
    recordLineSentMessages(
      "busy",
      Array.from({ length: 2000 }, (_, index) => `busy-${index}`),
    );

    expect(resolveLineQuotedMessage("quiet", "quiet-1", "C-room")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("busy", "busy-1999", "C-room")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("busy", "busy-0", "C-room")).toBeUndefined();
  });

  it("keeps one chat's text out of another chat's prompt", () => {
    recordLineAgentVisibleMessage("default", {
      id: "cross-1",
      conversationId: "C-other-room",
      body: "the deploy key is in 1Password",
      senderId: "U-teammate",
    });

    expect(resolveLineQuotedMessage("default", "cross-1", "C-room")).toBeUndefined();
    expect(resolveLineQuotedMessage("default", "cross-1", "C-other-room")?.body).toBe(
      "the deploy key is in 1Password",
    );
  });

  it("keeps the bot's own ids while a busy conversation fills the inbound bound", () => {
    recordLineSentMessages("mixed", ["bot-said-this"]);
    for (let index = 0; index < 600; index += 1) {
      recordLineAgentVisibleMessage("mixed", {
        id: `chatter-${index}`,
        conversationId: "C-busy",
        body: "chatter",
      });
    }

    // Quoting the bot is how a group member addresses it, so inbound volume must
    // not be able to evict that answer.
    expect(resolveLineQuotedMessage("mixed", "bot-said-this", "C-busy")).toEqual({ fromBot: true });
    expect(resolveLineQuotedMessage("mixed", "chatter-0", "C-busy")).toBeUndefined();
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

    expect(resolveLineQuotedMessage("refresh", "kept", "C-room")).toEqual({ fromBot: true });
  });
});
