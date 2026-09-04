/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";

async function flushAttachmentResolution() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("local assistant attachment media", () => {
  it.each([
    ["audio", "clip.mp3", "audio/mpeg", "openclaw-chat-audio-player"],
    ["video", "clip.mp4", "video/mp4", "openclaw-chat-video-player"],
    ["document", "notes.txt", "text/plain", ".chat-assistant-attachment-card__download"],
  ] as const)(
    "resolves local %s attachments through the Gateway without forwarding a bearer token",
    async (kind, label, mimeType, selector) => {
      const source = `/tmp/openclaw/${label}`;
      const resolveAssistantMedia = vi.fn(async () => ({
        available: true as const,
        mediaTicket: `ticket-${kind}`,
        mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const container = document.body.appendChild(document.createElement("div"));
      const rerender = () =>
        render(
          renderAssistantAttachments(
            [{ type: "attachment", attachment: { kind, label, mimeType, url: source } }],
            {
              assistantMediaScope: "agent:research:attachment-test",
              authToken: "must-not-be-forwarded",
              localMediaPreviewRoots: ["/tmp/default-agent"],
              onRequestUpdate: rerender,
              resolveAssistantMedia,
            },
          ),
          container,
        );

      rerender();
      await flushAttachmentResolution();
      rerender();

      const media = expectDefined(container.querySelector(selector), `${kind} local media`);
      const resolvedSource =
        media instanceof HTMLAnchorElement
          ? media.getAttribute("href")
          : (media as HTMLElement & { src?: string }).src;
      expect(resolvedSource).toContain(`mediaTicket=ticket-${kind}`);
      if (!(media instanceof HTMLAnchorElement)) {
        expect(media).toMatchObject({ authToken: null });
      }
      expect(resolveAssistantMedia).toHaveBeenCalledWith(source, "agent:research:attachment-test");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
