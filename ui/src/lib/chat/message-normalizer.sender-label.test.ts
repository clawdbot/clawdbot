// @vitest-environment node
import { describe, it, expect } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import { normalizeMessage } from "./message-normalizer.ts";

// Inbound context blocks are stamped with the provenance marker; strippers key
// on the marker, so display fixtures must carry it to be recognized.
const SENDER_METADATA_BLOCK = `${markInboundContextLabel("Sender:")}\n\`\`\`json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n\`\`\``;

describe("message-normalizer sender labels", () => {
  it("normalizes message with string content", () => {
    const result = normalizeMessage({
      role: "user",
      content: "Hello world",
      timestamp: 1000,
      id: "msg-1",
    });

    expect(result).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello world" }],
      timestamp: 1000,
      id: "msg-1",
      senderLabel: null,
    });
  });

  it("strips sender metadata blocks before displaying message text", () => {
    const result = normalizeMessage({
      role: "assistant",
      content: `${SENDER_METADATA_BLOCK}\n\nVisible reply`,
    });

    expect(result.content).toEqual([{ type: "text", text: "Visible reply" }]);
  });

  it("drops standalone sender metadata blocks before display", () => {
    const result = normalizeMessage({
      role: "system",
      content: SENDER_METADATA_BLOCK,
    });

    expect(result.content).toStrictEqual([]);
  });

  it("preserves top-level sender labels", () => {
    const result = normalizeMessage({
      role: "user",
      content: "Hello from QuietChat",
      senderLabel: "Iris",
    });

    expect(result.senderLabel).toBe("Iris");
  });

  it("formats durable sender metadata for transcript attribution", () => {
    const emailSender = normalizeMessage({
      role: "user",
      content: "Prompt from Alice",
      __openclaw: { senderId: "alice@example.com" },
    });
    expect(emailSender.senderLabel).toBe("alice");
    expect(emailSender.sender).toEqual({ id: "alice@example.com" });
    expect(
      normalizeMessage({
        role: "user",
        content: "Prompt from a profile",
        __openclaw: { senderId: "profile_123", senderName: "Alice Example" },
      }).senderLabel,
    ).toBe("Alice Example");
  });
});

describe("sender label opaque-id stripping", () => {
  it.each([
    { type: "profile", id: "x".repeat(513) },
    { type: "profile", id: "profile", label: "untrusted extra field" },
    { type: "observation", id: "profile" },
  ])("drops invalid sender provenance without losing display attribution: %j", (senderIdentity) => {
    expect(
      normalizeMessage({
        role: "user",
        content: "hello",
        __openclaw: {
          senderIdentity,
          senderId: "profile",
          senderName: "Display",
          senderProfileAvatarUrl: "/api/users/profile/avatar",
        },
      }).sender,
    ).toEqual({ id: "profile", name: "Display" });
  });

  it("sender provenance preserves typed identity and refuses unqualified profile display", () => {
    const identity = { type: "profile", id: "shared-id" };
    const metadata = {
      senderId: "shared-id",
      senderName: "Person",
      senderProfileAvatarUrl: "/api/users/shared-id/avatar",
    };
    expect(
      normalizeMessage({
        role: "user",
        content: "hello",
        __openclaw: { ...metadata, senderIdentity: identity },
      }).sender,
    ).toEqual({
      id: "shared-id",
      name: "Person",
      profileAvatarUrl: metadata.senderProfileAvatarUrl,
      identity,
    });
    expect(
      normalizeMessage({ role: "user", content: "hello", __openclaw: metadata }).sender,
    ).toEqual({ id: "shared-id", name: "Person" });
  });

  it.each([
    {
      behavior: "strips a baked UUID suffix without inventing profile identity",
      senderLabel: "steipete (c3e32452-0467-47e5-aafa-233cd5dae29f)",
      expectedLabel: "steipete",
    },
    {
      behavior: "keeps human-meaningful parenthesized suffixes",
      senderLabel: "Peter (+436641234567)",
      expectedLabel: "Peter (+436641234567)",
    },
    {
      behavior: "keeps a label that is only a UUID rather than emptying it",
      senderLabel: "(c3e32452-0467-47e5-aafa-233cd5dae29f)",
      expectedLabel: "(c3e32452-0467-47e5-aafa-233cd5dae29f)",
    },
    {
      behavior: "keeps a bare-UUID legacy label as display only",
      senderLabel: "c3e32452-0467-47e5-aafa-233cd5dae29f",
      expectedLabel: "c3e32452-0467-47e5-aafa-233cd5dae29f",
    },
  ])("$behavior", ({ senderLabel, expectedLabel }) => {
    const normalized = normalizeMessage({
      role: "user",
      content: "hi",
      senderLabel,
    });
    expect(normalized.senderLabel).toBe(expectedLabel);
    expect(normalized.sender).toEqual({ name: expectedLabel });
  });

  it("prefers durable metadata identity over the legacy label identity", () => {
    const normalized = normalizeMessage({
      role: "user",
      content: "hi",
      senderLabel: "steipete (c3e32452-0467-47e5-aafa-233cd5dae29f)",
      __openclaw: { senderId: "meta-profile", senderName: "Meta Name" },
    });
    expect(normalized.sender).toEqual({ id: "meta-profile", name: "Meta Name" });
    expect(normalized.senderLabel).toBe("steipete");
  });
});
