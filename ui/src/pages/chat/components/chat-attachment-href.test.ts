import { describe, expect, it } from "vitest";
import { safeAttachmentHref } from "./chat-attachment-href.ts";

describe("safeAttachmentHref", () => {
  it.each([
    "https://cdn.example/audio.mp3",
    "HtTp://cdn.example/video.mp4",
    "blob:https://control.example/15ed4f80-4fb5-4ca6-a6e6-3c9a8943a003",
    "/downloads/report.pdf",
    "/__openclaw__/assistant-media?source=report.pdf",
    "/media/inbound/attachment",
    "/api/chat/media/outgoing/main/document/full",
  ])("allows a safe attachment href: %s", (href) => {
    expect(safeAttachmentHref(`  ${href}  `)).toBe(href);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//attacker.example/file.mp3",
    "relative/file.mp3",
    "",
  ])("rejects an unsafe attachment href: %s", (href) => {
    expect(safeAttachmentHref(href)).toBeUndefined();
  });
});
