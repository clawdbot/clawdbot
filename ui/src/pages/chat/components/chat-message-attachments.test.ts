/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { releaseChatMediaResourceSubscriber, type AttachmentItem } from "./chat-message-media.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

type AttachmentSidebarContent = Extract<SidebarContent, { kind: "attachment" }>;

function managedAttachment(url: string, artifactId?: string): AttachmentItem {
  return {
    type: "attachment",
    attachment: {
      kind: "document",
      label: "asset.bin",
      mimeType: "application/octet-stream",
      url,
      artifactId,
    },
  };
}

async function flushAttachmentResolution() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

const subscribers = new Set<() => void>();

afterEach(() => {
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  vi.useRealTimers();
});

describe("attachment sidebar source ownership", () => {
  it("retries a failed managed attachment resolution", async () => {
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_document_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=recovered`;
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ url: ticketedUrl });
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderAssistantAttachments([managedAttachment(source, artifactId)], {
          onRequestUpdate: rerender,
          resolveArtifactDownload,
        }),
        container,
      );
    subscribers.add(rerender);

    rerender();
    await flushAttachmentResolution();
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__retry")?.click();
    await flushAttachmentResolution();

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).toBeNull();
    expect(
      container
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("href"),
    ).toBe(ticketedUrl);
    container.remove();
  });

  it("keeps static attachment URLs as static sidebar sources", async () => {
    const source = "https://example.com/clip.mp4";
    const container = document.body.appendChild(document.createElement("div"));
    let sidebarContent: AttachmentSidebarContent | undefined;
    render(
      renderAssistantAttachments([managedAttachment(source)], {}, undefined, (content) => {
        if (content.kind === "attachment") {
          sidebarContent = content;
        }
      }),
      container,
    );
    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();

    expect(sidebarContent?.src).toBe(source);
    expect(sidebarContent?.resolveSource).toBeUndefined();
    container.remove();
  });

  it("keeps an open sidebar on the canonical managed source across ticket renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_video_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const firstTicket = `${source}?mediaTicket=A`;
    const renewedTicket = `${source}?mediaTicket=B`;
    const resolveArtifactDownload = vi
      .fn<() => Promise<{ url: string; expiresAt: string }>>()
      .mockResolvedValueOnce({
        url: firstTicket,
        expiresAt: new Date(Date.now() + 31_000).toISOString(),
      })
      .mockResolvedValueOnce({
        url: renewedTicket,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    const container = document.body.appendChild(document.createElement("div"));
    let sidebarContent: AttachmentSidebarContent | undefined;
    const transcriptUpdate = () => rerender();
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [managedAttachment(source, artifactId)],
          { onRequestUpdate: transcriptUpdate, resolveArtifactDownload },
          undefined,
          (content) => {
            if (content.kind === "attachment") {
              sidebarContent = content;
            }
          },
        ),
        container,
      );
    subscribers.add(transcriptUpdate);

    rerender();
    await flushAttachmentResolution();
    rerender();
    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();

    expect(sidebarContent?.src).toBeUndefined();
    expect(sidebarContent?.sourceIdentity).toBe(source);
    const sidebarUpdate = vi.fn();
    subscribers.add(sidebarUpdate);
    expect(sidebarContent?.resolveSource?.(sidebarUpdate)?.src).toBe(firstTicket);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sidebarUpdate).toHaveBeenCalled();
    expect(sidebarContent?.resolveSource?.(sidebarUpdate)?.src).toBe(renewedTicket);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    container.remove();
  });
});
