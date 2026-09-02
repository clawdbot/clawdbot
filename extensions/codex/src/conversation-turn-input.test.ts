// Codex tests cover conversation turn input plugin behavior.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCodexConversationTurnInput } from "./conversation-turn-input.js";

const localFileCases = ["file", "FILE", "FiLe"].flatMap((scheme) =>
  ["mediaPath", "mediaUrl"].map((field) => ({ scheme, field })),
);

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

  it("uses staged remote-cache paths for remote iMessage image attachments", () => {
    const rawPath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const stagedPath = "/tmp/openclaw-proof/.openclaw/media/remote-cache/imessage/photo.jpg";

    const input = buildCodexConversationTurnInput({
      prompt: "what is this?",
      event: {
        content: "what is this?",
        channel: "imessage",
        isGroup: false,
        metadata: {
          mediaPaths: [stagedPath],
          mediaTypes: ["image/jpeg"],
          originalMediaPaths: [rawPath],
        },
      },
    });

    expect(input).toEqual([
      { type: "text", text: "what is this?", text_elements: [] },
      { type: "localImage", path: stagedPath },
    ]);
    expect(input).not.toContainEqual({ type: "localImage", path: rawPath });
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

  it.each(localFileCases)(
    "decodes $scheme URLs from $field for local images",
    ({ scheme, field }) => {
      const imagePath = path.resolve("OpenClaw QA", "photo #1?.png");
      expect(
        buildCodexConversationTurnInput({
          prompt: "look",
          event: {
            content: "look",
            channel: "webchat",
            isGroup: false,
            metadata: {
              [field]: pathToFileURL(imagePath).href.replace(/^file:/, `${scheme}:`),
              mediaType: "image/png",
            },
          },
        }),
      ).toEqual([
        { type: "text", text: "look", text_elements: [] },
        { type: "localImage", path: imagePath },
      ]);
    },
  );

  it.each(localFileCases)("drops malformed $scheme URLs from $field", ({ scheme, field }) => {
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            [field]: `${scheme}:///tmp/%zz/photo.png`,
            mediaType: "image/png",
          },
        },
      }),
    ).toEqual([{ type: "text", text: "look", text_elements: [] }]);
  });

  it.each(localFileCases)(
    "rejects encoded separators in $scheme URLs from $field",
    ({ scheme, field }) => {
      expect(
        buildCodexConversationTurnInput({
          prompt: "look",
          event: {
            content: "look",
            channel: "webchat",
            isGroup: false,
            metadata: { [field]: `${scheme}:///tmp/hidden%2Fphoto.png`, mediaType: "image/png" },
          },
        }),
      ).toEqual([{ type: "text", text: "look", text_elements: [] }]);
    },
  );

  it.skipIf(process.platform === "win32").each(localFileCases)(
    "preserves POSIX backslash filenames in $scheme URLs from $field",
    ({ scheme, field }) => {
      expect(
        buildCodexConversationTurnInput({
          prompt: "look",
          event: {
            content: "look",
            channel: "webchat",
            isGroup: false,
            metadata: { [field]: `${scheme}:///tmp/photo%5Cname.png`, mediaType: "image/png" },
          },
        }),
      ).toEqual([
        { type: "text", text: "look", text_elements: [] },
        { type: "localImage", path: "/tmp/photo\\name.png" },
      ]);
    },
  );

  it("treats local media URLs as Codex local image input", () => {
    const secondImagePath = path.resolve("OpenClaw QA", "second.jpg");
    expect(
      buildCodexConversationTurnInput({
        prompt: "look",
        event: {
          content: "look",
          channel: "webchat",
          isGroup: false,
          metadata: {
            mediaUrls: ["/tmp/staged-photo.png", pathToFileURL(secondImagePath).href],
            mediaTypes: ["image/png", "image/jpeg"],
          },
        },
      }),
    ).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/tmp/staged-photo.png" },
      { type: "localImage", path: secondImagePath },
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
