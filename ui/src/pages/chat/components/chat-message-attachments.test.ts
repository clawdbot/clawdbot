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

function stubAttachmentIntersection(): () => Promise<void> {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  return async () => {
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    callbacks.shift()?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  };
}

afterEach(() => {
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("attachment sidebar source ownership", () => {
  it.each([
    ["sample-image.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
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

  it("loads SVG attachments through an image object URL", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const source = "https://example.com/vector.svg";
    const objectUrl = "blob:svg-attachment";
    let objectBlob: Blob | undefined;
    const revokeObjectURL = vi.fn();
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn((object: Blob | MediaSource) => {
          if (object instanceof Blob) {
            objectBlob = object;
          }
          return objectUrl;
        });
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>', {
          headers: { "Content-Type": "image/svg+xml" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenImage = vi.fn();
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "vector.svg",
              mimeType: "image/svg+xml",
              url: source,
            },
          },
        ],
        { onOpenImage },
      ),
      container,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await intersectAttachment();

    await vi.waitFor(() =>
      expect(container.querySelector("img.chat-message-image")?.getAttribute("src")).toBe(
        objectUrl,
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        credentials: "same-origin",
        headers: { Accept: "image/svg+xml" },
        method: "GET",
      }),
    );
    expect(objectBlob?.type).toBe("image/svg+xml");
    expect(container.querySelector("iframe")).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-message-image-button")?.click();
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({ src: objectUrl, title: "vector.svg" }),
    );
    const lightboxItem = onOpenImage.mock.calls[0]?.[0] as { release?: () => void } | undefined;
    expect(lightboxItem?.release).toBeTypeOf("function");
    container.remove();
    expect(revokeObjectURL).not.toHaveBeenCalledWith(objectUrl);
    lightboxItem?.release?.();
    expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);
  });

  it("keeps a known oversized SVG compact without fetching it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "oversized.svg",
              mimeType: "image/svg+xml",
              sizeBytes: 256 * 1024 + 1,
              url: "https://example.com/oversized.svg",
            },
          },
        ],
        {},
        undefined,
        vi.fn(),
      ),
      container,
    );

    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels one oversized SVG chunk without creating an object URL", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const cancel = vi.fn();
    const createObjectURL = vi.fn();
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(256 * 1024 + 1));
              },
              cancel,
            }),
            { headers: { "Content-Type": "image/svg+xml" } },
          ),
      ) as unknown as typeof fetch,
    );
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "chunked.svg",
              mimeType: "image/svg+xml",
              url: "https://example.com/chunked.svg",
            },
          },
        ],
        {},
        undefined,
        vi.fn(),
      ),
      container,
    );

    await intersectAttachment();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a compact file card when an SVG image cannot render", async () => {
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => "blob:broken-svg");
        static override revokeObjectURL = vi.fn();
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () => new Response("<svg><broken", { headers: { "Content-Type": "image/svg+xml" } }),
      ),
    );
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenSidebar = vi.fn();
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "broken.svg",
              mimeType: "image/svg+xml",
              url: "https://example.com/broken.svg",
            },
          },
        ],
        {},
        undefined,
        onOpenSidebar,
      ),
      container,
    );

    const image = await vi.waitFor(() => {
      const candidate = container.querySelector<HTMLImageElement>("img.chat-message-image");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    image.dispatchEvent(new Event("error"));

    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    expect(container.querySelector("img.chat-message-image")).toBeNull();
    expect(
      container.querySelector(".chat-assistant-attachment-card__title")?.textContent,
    ).toContain("broken.svg");
    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();
    expect(onOpenSidebar).toHaveBeenCalledOnce();
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
          { connectionEpoch: 1, onRequestUpdate: transcriptUpdate, resolveArtifactDownload },
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
      connectionEpoch: 1,
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

  it("resolves an open managed sidebar attachment again after the connection epoch changes", async () => {
    const attachmentId = crypto.randomUUID();
    const artifactId = `artifact_managed_video_${attachmentId}`;
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const firstTicket = `${source}?mediaTicket=authority-A`;
    const secondTicket = `${source}?mediaTicket=authority-B`;
    const firstResolver = vi.fn(async () => ({ url: firstTicket }));
    const secondResolver = vi.fn(async () => ({ url: secondTicket }));
    const container = document.body.appendChild(document.createElement("div"));
    let sidebarContent: AttachmentSidebarContent | undefined;
    const transcriptUpdate = () => rerender();
    const rerender = () =>
      render(
        renderAssistantAttachments(
          [managedAttachment(source, artifactId)],
          {
            connectionEpoch: 1,
            onRequestUpdate: transcriptUpdate,
            resolveArtifactDownload: firstResolver,
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
    expect(
      sidebarContent?.resolveSource?.(sidebarUpdate, {
        connectionEpoch: 1,
        localMediaPreviewRoots: [],
        resolveArtifactDownload: firstResolver,
      })?.src,
    ).toBe(firstTicket);
    expect(
      sidebarContent?.resolveSource?.(sidebarUpdate, {
        connectionEpoch: 2,
        localMediaPreviewRoots: [],
        resolveArtifactDownload: secondResolver,
      }),
    ).toBeNull();
    await flushAttachmentResolution();

    expect(
      sidebarContent?.resolveSource?.(sidebarUpdate, {
        connectionEpoch: 2,
        localMediaPreviewRoots: [],
        resolveArtifactDownload: secondResolver,
      })?.src,
    ).toBe(secondTicket);
    expect(secondResolver).toHaveBeenCalledOnce();
    container.remove();
  });

  it("keeps data URL audio playable without offering a dead-end Files action", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenSidebar = vi.fn();
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "audio",
              label: "inline.wav",
              mimeType: "audio/wav",
              url: "data:audio/wav;base64,UklGRg==",
            },
          },
        ],
        {},
        undefined,
        onOpenSidebar,
      ),
      container,
    );

    expect(container.querySelector("openclaw-chat-audio-player")).not.toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__expand")).toBeNull();
    expect(onOpenSidebar).not.toHaveBeenCalled();
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
