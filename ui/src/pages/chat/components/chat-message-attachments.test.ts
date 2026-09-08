/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
    ["sample-image.png", "image/png", "https://example.com/sample-image.png"],
    ["photo.jpg", "image/jpeg", "https://example.com/photo.jpg"],
    ["photo.png", "application/octet-stream", `${window.location.origin}/download/opaque`],
    [
      "photo",
      "application/octet-stream; charset=binary",
      `${window.location.origin}/download/photo.png`,
    ],
  ])("renders document-shaped %s attachments as expandable images", (label, mimeType, source) => {
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

  it.each([
    { kind: "image", outcome: "offline" },
    { kind: "document", outcome: "offline" },
    { kind: "image", outcome: "missing" },
    { kind: "document", outcome: "denied" },
  ] as const)(
    "handles $outcome renewal after a local $kind raster has loaded",
    async ({ kind, outcome }) => {
      vi.useFakeTimers();
      const availableResponse = (mediaTicket: string) =>
        Response.json({
          available: true,
          mediaTicket,
          mediaTicketExpiresAt: new Date(Date.now() + 31_000).toISOString(),
        });
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(availableResponse("loaded"));
      vi.stubGlobal("fetch", fetchMock);
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => {
        render(null, container);
      });
      const attachment: AttachmentItem = {
        type: "attachment",
        attachment: {
          kind,
          label: "photo.png",
          mimeType: "image/png",
          url: `/tmp/openclaw/${crypto.randomUUID()}.png`,
        },
      };
      const rerender = () =>
        render(
          renderAssistantAttachments([attachment], {
            authToken: "test-token",
            onRequestUpdate: rerender,
          }),
          container,
        );
      subscribers.add(rerender);
      rerender();
      await vi.advanceTimersByTimeAsync(0);
      const displayed = expectDefined(container.querySelector("img"), "loaded raster image");
      expect(displayed.getAttribute("src")).toContain("mediaTicket=loaded");
      Object.defineProperty(displayed, "naturalWidth", { value: 1 });
      displayed.dispatchEvent(new Event("load"));
      if (outcome === "offline") {
        fetchMock.mockRejectedValue(new TypeError("Gateway offline"));
        await vi.advanceTimersByTimeAsync(11_000);
        expect(container.querySelector("img")).toBe(displayed);
        await vi.advanceTimersByTimeAsync(20_001);
        expect(container.querySelector("img")).toBe(displayed);
        expect(container.querySelector(".chat-assistant-attachment-card")).toBeNull();
      } else {
        const retryable = outcome === "missing";
        fetchMock.mockResolvedValueOnce(
          Response.json({ available: false, reason: "Attachment removed", retryable }),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(container.querySelector("img")).toBeNull();
        displayed.dispatchEvent(new Event("load"));
        displayed.dispatchEvent(new Event("error"));
        expect(container.querySelector("img")).toBeNull();
        const retry = container.querySelector<HTMLButtonElement>(
          ".chat-assistant-attachment-card__retry",
        );
        if (outcome === "missing") {
          expect(container.textContent).toContain("Attachment removed");
          fetchMock.mockResolvedValueOnce(availableResponse("recovered"));
          expectDefined(retry, "Retry action for a recoverable missing image").click();
          await vi.advanceTimersByTimeAsync(0);
          expect(container.querySelector("img")?.getAttribute("src")).toContain(
            "mediaTicket=recovered",
          );
        } else {
          expect(container.textContent).toContain("Unavailable");
          expect(retry).toBeNull();
        }
      }
    },
  );

  it("routes an SVG filename with an opaque source through the bounded SVG renderer", () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "vector.svg",
              mimeType: "application/octet-stream",
              url: "https://files.example/download/opaque",
            },
          },
        ],
        {},
      ),
      container,
    );

    expect(container.querySelector("openclaw-chat-svg-attachment")).not.toBeNull();
    expect(container.querySelector("img.chat-message-image")).toBeNull();
    container.remove();
  });

  it("does not let an SVG-shaped label override a document MIME type", () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "vector.svg",
              mimeType: "application/pdf",
              url: "https://files.example/document.pdf",
            },
          },
        ],
        {},
      ),
      container,
    );

    expect(container.querySelector("openclaw-chat-svg-attachment")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card")).not.toBeNull();
    container.remove();
  });

  it("loads SVG attachments through an image object URL", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const source = `${window.location.origin}/vector.svg`;
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
    const onAssistantAttachmentLoaded = vi.fn();
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
        undefined,
        onAssistantAttachmentLoaded,
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
    container.querySelector("img.chat-message-image")?.dispatchEvent(new Event("load"));
    expect(onAssistantAttachmentLoaded).toHaveBeenCalledOnce();
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

  it("keeps a cross-origin SVG with an extensionless label compact under the image CSP", async () => {
    const source = "https://cdn.example/vector.svg";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenSidebar = vi.fn();
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "image",
              label: "diagram",
              url: source,
            },
          },
        ],
        {},
        onOpenSidebar,
      ),
      container,
    );

    await vi.waitFor(() =>
      expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("img.chat-message-image")).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attachment", attachmentKind: "image", src: source }),
    );
  });

  it("reloads a same-origin SVG after its element reconnects", async () => {
    const intersectAttachment = stubAttachmentIntersection();
    const objectUrls = ["blob:svg-first", "blob:svg-second"];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => objectUrls.shift() ?? "blob:extra");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
          headers: { "Content-Type": "image/svg+xml" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "reconnected.svg",
              mimeType: "image/svg+xml",
              url: `${window.location.origin}/reconnected.svg`,
            },
          },
        ],
        {},
      ),
      container,
    );

    await intersectAttachment();
    await vi.waitFor(() =>
      expect(container.querySelector("img.chat-message-image")?.getAttribute("src")).toBe(
        "blob:svg-first",
      ),
    );
    const attachment = container.querySelector("openclaw-chat-svg-attachment")!;
    attachment.remove();
    container.append(attachment);
    await intersectAttachment();

    await vi.waitFor(() =>
      expect(container.querySelector("img.chat-message-image")?.getAttribute("src")).toBe(
        "blob:svg-second",
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
              url: `${window.location.origin}/chunked.svg`,
            },
          },
        ],
        {},
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

  it("falls back to the SVG card when a same-origin fetch stalls", async () => {
    vi.useFakeTimers();
    const intersectAttachment = stubAttachmentIntersection();
    const fetchMock = vi.fn(async () => await new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.body.appendChild(document.createElement("div"));
    const onAssistantAttachmentLoaded = vi.fn();
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "stalled.svg",
              mimeType: "image/svg+xml",
              url: `${window.location.origin}/stalled.svg`,
            },
          },
        ],
        {},
        undefined,
        onAssistantAttachmentLoaded,
      ),
      container,
    );

    await intersectAttachment();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(container.querySelector(".chat-assistant-attachment-card--compact")).not.toBeNull();
    expect(onAssistantAttachmentLoaded).toHaveBeenCalledOnce();
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
              url: `${window.location.origin}/broken.svg`,
            },
          },
        ],
        {},
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
      renderAssistantAttachments([managedAttachment(source)], {}, (content) => {
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

  it("does not expose a Files action without a sidebar owner", () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments([managedAttachment("https://example.com/asset.bin")], {}),
      container,
    );

    expect(container.querySelector(".chat-assistant-attachment-card__expand")).toBeNull();
    expect(
      container.querySelector(".chat-assistant-attachment-card")?.hasAttribute("data-openable"),
    ).toBe(false);
    container.remove();
  });

  it("prefixes managed attachment tickets with the Control UI resource base path", async () => {
    const attachmentId = crypto.randomUUID();
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    const ticketedUrl = `${source}?mediaTicket=ticket`;
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const container = document.body.appendChild(document.createElement("div"));
    const rerender = () =>
      render(
        renderAssistantAttachments([managedAttachment(source, `artifact_${attachmentId}`)], {
          onRequestUpdate: rerender,
          resourceBasePath: "/rosita",
          resolveArtifactDownload,
        }),
        container,
      );
    subscribers.add(rerender);

    rerender();
    await flushAttachmentResolution();

    expect(
      container
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("href"),
    ).toBe(`/rosita${ticketedUrl}`);
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
        resolveArtifactDownload: firstResolver,
      })?.src,
    ).toBe(firstTicket);
    expect(
      sidebarContent?.resolveSource?.(sidebarUpdate, {
        connectionEpoch: 2,
        resolveArtifactDownload: secondResolver,
      }),
    ).toBeNull();
    await flushAttachmentResolution();

    expect(
      sidebarContent?.resolveSource?.(sidebarUpdate, {
        connectionEpoch: 2,
        resolveArtifactDownload: secondResolver,
      })?.src,
    ).toBe(secondTicket);
    expect(secondResolver).toHaveBeenCalledOnce();
    container.remove();
  });

  it.each([
    ["audio", "recording.mp3", "audio/mpeg", "openclaw-chat-audio-player", undefined],
    ["audio", "recording.ogg", "audio/ogg", "openclaw-chat-audio-player", "transcode"],
    ["audio", "recording.m4a", "audio/x-m4a", "openclaw-chat-audio-player", undefined],
    ["audio", "recording.flac", "audio/flac", "openclaw-chat-audio-player", "transcode"],
    ["video", "demo.mp4", "video/mp4", "openclaw-chat-video-player", undefined],
    ["video", "demo.webm", "video/webm", "openclaw-chat-video-player", "transcode"],
  ] as const)(
    "renders %s attachment %s with inline playback",
    (kind, label, mimeType, player, requestedPlayback) => {
      const source = `https://example.com/${label}`;
      const playback = requestedPlayback ?? "native";
      const container = document.body.appendChild(document.createElement("div"));
      const onOpenSidebar = vi.fn();
      render(
        renderAssistantAttachments(
          [
            {
              type: "attachment",
              attachment: { kind, label, mimeType, playback, url: source },
            },
          ],
          {},
          onOpenSidebar,
        ),
        container,
      );

      const mediaPlayer = container.querySelector(player);
      expect(mediaPlayer).toMatchObject({ playback, sourceIdentity: source, src: source });
      container.remove();
    },
  );

  it.each([
    ["audio", "unsafe.mp3", "audio/mpeg", "javascript:alert(1)"],
    ["video", "unsafe.mp4", "video/mp4", "data:text/html;base64,PHNjcmlwdD4="],
  ] as const)("blocks unsafe %s player source %s", (kind, label, mimeType, url) => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [{ type: "attachment", attachment: { kind, label, mimeType, url } }],
        {},
      ),
      container,
    );

    expect(container.querySelector("openclaw-chat-audio-player")).toBeNull();
    expect(container.querySelector("openclaw-chat-video-player")).toBeNull();
    expect(container.querySelector("audio, video")).toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card--blocked")).not.toBeNull();
    expect(container.querySelector(".chat-assistant-attachment-card__download")).toBeNull();
    expect(container.textContent).toContain(label);
    container.remove();
  });

  it.each([
    ["document", "preview.html", "text/html"],
    ["document", "brief.pdf", "application/pdf"],
    ["document", "rows.csv", "text/csv"],
    [
      "document",
      "notes.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  ] as const)("renders %s attachment %s as one compact card", (kind, label, mimeType) => {
    const source = `https://example.com/${label}`;
    const container = document.body.appendChild(document.createElement("div"));
    const onOpenSidebar = vi.fn();
    render(
      renderAssistantAttachments(
        [{ type: "attachment", attachment: { kind, label, mimeType, url: source } }],
        {},
        onOpenSidebar,
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-assistant-attachment-card--compact")).toHaveLength(1);
    expect(container.querySelector(".chat-assistant-attachment-card__title")?.textContent).toBe(
      label,
    );
    expect(
      container
        .querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download")
        ?.getAttribute("href"),
    ).toBe(source);
    expect(container.querySelector("iframe, table, audio, video")).toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")?.click();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attachment", attachmentKind: kind, title: label }),
    );
    container.remove();
  });

  it("renders named attachment failures with separable status and reason text", () => {
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment_error",
            attachment: {
              code: "unsupported-format",
              kind: "document",
              label: "settings.toml",
            },
          },
        ],
        {},
      ),
      container,
    );

    expect(container.querySelector(".chat-assistant-attachment-card__title")?.textContent).toBe(
      "settings.toml",
    );
    expect(container.querySelectorAll(".chat-assistant-attachment-card")).toHaveLength(1);
    expect(container.querySelector(".chat-assistant-attachment-card--definitive")).not.toBeNull();
    expect(
      container.querySelector(".chat-assistant-attachment-card__status-badge")?.textContent,
    ).toBe("Not sent");
    expect(
      container.querySelector(".chat-assistant-attachment-card__status-separator")?.textContent,
    ).toBe("·");
    expect(
      container
        .querySelector(".chat-assistant-attachment-card__status-separator")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      container.querySelector(".chat-assistant-attachment-card__status-reason")?.textContent,
    ).toBe("Rejected by the local attachment allowlist. Send a supported file type.");
    expect(
      container.querySelector(
        ".chat-assistant-attachment-card__download, .chat-assistant-attachment-card__expand, .chat-assistant-attachment-card__retry",
      ),
    ).toBeNull();
    container.remove();
  });

  it("renders normalized base64 audio with inline playback and Files actions", () => {
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
        onOpenSidebar,
      ),
      container,
    );

    const player = container.querySelector("openclaw-chat-audio-player");
    expect(player).toMatchObject({
      label: "inline.wav",
      mimeType: "audio/wav",
      onExpand: expect.any(Function),
      sourceIdentity: "data:audio/wav;base64,UklGRg==",
      src: "data:audio/wav;base64,UklGRg==",
    });
    expect(container.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
    (player as HTMLElement & { onExpand: () => void }).onExpand();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentKind: "audio",
        src: "data:audio/wav;base64,UklGRg==",
      }),
    );
    container.remove();
  });

  it("resolves an open local sidebar attachment with the current runtime credentials", async () => {
    const source = "/tmp/openclaw/clip.mp3";
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
                kind: "audio",
                label: "clip.mp3",
                mimeType: "audio/mpeg",
                url: source,
              },
            },
          ],
          {
            authToken: "token-A",
            onRequestUpdate: transcriptUpdate,
          },
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
            resourceBasePath?: string;
          },
        ) => { src: string; authToken?: string | null } | null)
      | undefined;
    expect(resolveSource).toBeDefined();
    expect(
      resolveSource?.(sidebarUpdate, {
        authToken: "token-B",
      }),
    ).toBeNull();
    await flushAttachmentResolution();

    expect(
      resolveSource?.(sidebarUpdate, {
        authToken: "token-B",
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
