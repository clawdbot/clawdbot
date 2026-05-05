import { describe, expect, it } from "vitest";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

describe("codex conversation turn input", () => {
  it("forwards inbound image attachments to Codex app-server", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "what is this?",
        event: {
          content: "what is this?",
          channel: "telegram",
          isGroup: false,
          metadata: {
            mediaPaths: ["/tmp/photo.png", "/tmp/readme.txt"],
            mediaUrls: ["https://example.test/photo.png"],
            mediaTypes: ["image/png", "text/plain"],
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "what is this?", text_elements: [] },
      { type: "localImage", path: "/tmp/photo.png" },
    ]);
  });

  it("uses remote image urls when no local path is available", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaUrl: "https://example.test/photo.webp?sig=1",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "https://example.test/photo.webp?sig=1" },
    ]);
  });

  it("keeps protocol-relative image urls remote", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaUrl: "//cdn.example.test/photo.webp",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "image", url: "//cdn.example.test/photo.webp" },
    ]);
  });

  it("decodes local file URLs for Codex local image input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaPath: "file:///tmp/OpenClaw%20QA/photo.png",
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/OpenClaw QA/photo.png" },
    ]);
  });

  it("drops malformed local file URLs instead of throwing", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaPath: "file:///tmp/%zz/photo.png",
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([{ type: "text", text: "look", text_elements: [] }]);
  });

  it("treats local media URLs as Codex local image input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaUrls: ["/tmp/staged-photo.png", "file:///tmp/OpenClaw%20QA/second.jpg"],
            mediaTypes: ["image/png", "image/jpeg"],
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/staged-photo.png" },
      { type: "localImage", path: "/tmp/OpenClaw QA/second.jpg" },
    ]);
  });

  it("treats Windows media paths as Codex local image input", () => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaUrl: "C:\\OpenClaw QA\\photo.png",
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "C:\\OpenClaw QA\\photo.png" },
    ]);
  });
});
