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
  it.each([
    ["sample-image.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["vector.svg", "image/svg+xml"],
  ])("renders document-shaped %s attachments as expandable images", (label, mimeType) => {
    const source = `https://example.com/${label}`;
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenImage = vi.fn();
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: { kind: "document", label, mimeType, url: source },
          },
        ],
        { onOpenImage },
      ),
      container,
    );

    expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();
    expect(container.querySelector("img.chat-message-image")?.getAttribute("src")).toBe(source);
    container.querySelector<HTMLButtonElement>(".chat-message-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: source, title: label }),
    );
    container.remove();
  });

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
    const runtime = {
      localMediaPreviewRoots: [],
      resolveArtifactDownload,
    };
    expect(sidebarContent?.resolveSource?.(sidebarUpdate, runtime)?.src).toBe(firstTicket);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sidebarUpdate).toHaveBeenCalled();
    expect(sidebarContent?.resolveSource?.(sidebarUpdate, runtime)?.src).toBe(renewedTicket);
    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    container.remove();
  });

  it("resolves an open local sidebar attachment with the current runtime credentials", async () => {
    const source = "/tmp/openclaw/clip.mp4";
    const container = document.body.appendChild(document.createElement("div"));
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      return new Response(
        JSON.stringify({
          available: true,
          mediaTicket: `ticket-${token}`,
          mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    let sidebarContent: AttachmentSidebarContent | undefined;
    const transcriptUpdate = () => rerender();
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [
            {
              type: "attachment",
              attachment: {
                kind: "video",
                label: "clip.mp4",
                mimeType: "video/mp4",
                url: source,
              },
            },
          ],
          {
            authToken: "token-A",
            localMediaPreviewRoots: ["/tmp/openclaw"],
            onRequestUpdate: transcriptUpdate,
          },
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

    const sidebarUpdate = vi.fn();
    subscribers.add(sidebarUpdate);
    const resolveSource = sidebarContent?.resolveSource as unknown as
      | ((
          onRequestUpdate: () => void,
          runtime: {
            authToken?: string | null;
            localMediaPreviewRoots: readonly string[];
            resourceBasePath?: string;
          },
        ) => { src: string; authToken?: string | null } | null)
      | undefined;
    expect(resolveSource).toBeDefined();
    expect(
      resolveSource?.(sidebarUpdate, {
        authToken: "token-B",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      }),
    ).toBeNull();
    await flushAttachmentResolution();

    expect(
      resolveSource?.(sidebarUpdate, {
        authToken: "token-B",
        localMediaPreviewRoots: ["/tmp/openclaw"],
      }),
    ).toEqual(
      expect.objectContaining({
        authToken: "token-B",
        src: expect.stringContaining("mediaTicket=ticket-token-B"),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
      "Bearer token-B",
    );
    container.remove();
  });
});
