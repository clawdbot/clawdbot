/* @vitest-environment jsdom */

import { html, render } from "lit";
import { guard } from "lit/directives/guard.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResource,
  readManagedImageBlobUrl,
  releaseChatMediaResourceSubscriber,
  schedulePairingQrExpiryRefresh,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

const subscribers = new Set<() => void>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
});

afterEach(() => {
  for (const subscriber of subscribers) {
    releaseChatMediaResourceSubscriber(subscriber);
  }
  subscribers.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function managedImageSource(): string {
  return `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
}

function managedImageResourceKey(source: string): string {
  return `${source.replace(/\/full$/u, "/thumbnail")}::::`;
}

function installManagedImageUrls(): string {
  const NativeUrl = URL;
  const blobUrl = `blob:managed-image-${crypto.randomUUID()}`;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = vi.fn(() => blobUrl);
      static override revokeObjectURL = vi.fn();
    },
  );
  return blobUrl;
}

function imageResponse() {
  return {
    ok: true,
    blob: async () => new Blob(["png"], { type: "image/png" }),
  };
}

function renderManagedImage(
  container: HTMLElement,
  source: string,
  options: ImageRenderOptions = {},
  artifactId?: string,
) {
  const image: ImageBlock = {
    url: source,
    alt: "Managed image",
    ...(artifactId ? { artifactId } : {}),
  };
  render(renderMessageImages([image], options), container);
}

function observeSubscriber(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return subscriber;
}

describe("chat media resource lifecycle", () => {
  it("scopes image approval to its session and renews the approved ticket", async () => {
    const source = "/outside/project/preview.png";
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://control.test");
      expect(url.searchParams.get("source")).toBe(source);
      expect(url.searchParams.get("agentId")).toBe("main");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer image-test-token");
      const protectedSession = url.searchParams.get("sessionKey") === "protected";
      const approving = init?.method === "POST";
      const renewing = url.searchParams.get("mediaTicket") === "approved-image";
      if (approving) {
        expect(url.searchParams.get("allow")).toBe("1");
      }
      return {
        ok: true,
        json: async () =>
          protectedSession && !approving && !renewing
            ? {
                available: false,
                reason: "Outside allowed folders",
                retryable: false,
                canAllow: true,
              }
            : {
                available: true,
                mediaTicket: renewing
                  ? "renewed-image"
                  : approving
                    ? "approved-image"
                    : "open-image",
                mediaTicketExpiresAt: new Date(
                  Date.now() + (approving ? 31_000 : 90_000),
                ).toISOString(),
              },
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const protectedPane = document.createElement("div");
    const openPane = document.createElement("div");
    const renderPane = (container: HTMLElement, sessionKey: string, onRequestUpdate: () => void) =>
      render(
        renderMessageImages([{ url: source, fileName: "preview.png" }], {
          sessionKey,
          agentId: "main",
          authToken: "image-test-token",
          localMediaPreviewRoots: ["/tmp/openclaw"],
          onRequestUpdate,
        }),
        container,
      );
    const renderProtected = observeSubscriber(() =>
      renderPane(protectedPane, "protected", renderProtected),
    );
    const renderOpen = observeSubscriber(() => renderPane(openPane, "unprotected", renderOpen));

    renderProtected();
    renderOpen();
    await vi.advanceTimersByTimeAsync(0);

    expect(protectedPane.querySelector("img")).toBeNull();
    expect(
      protectedPane.querySelector(".chat-assistant-attachment-card__title")?.getAttribute("title"),
    ).toBe(source);
    expect(openPane.querySelector("img")?.getAttribute("src")).toContain("mediaTicket=open-image");
    const allowButton = protectedPane.querySelector<HTMLButtonElement>("button");
    expect(allowButton?.textContent?.trim()).toBe("Allow image");
    allowButton?.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(protectedPane.querySelector("img")?.getAttribute("src")).toContain(
      "mediaTicket=approved-image",
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const imageUrl = new URL(
      protectedPane.querySelector("img")!.getAttribute("src")!,
      "https://control.test",
    );
    expect(imageUrl.searchParams.get("mediaTicket")).toBe("renewed-image");
    expect(imageUrl.searchParams.get("sessionKey")).toBe("protected");
    expect(imageUrl.searchParams.get("agentId")).toBe("main");
    expect(openPane.querySelector("img")?.getAttribute("src")).toContain("mediaTicket=open-image");
  });

  it("marks one-to-five image turns for the transcript and sent-message layouts", () => {
    const container = document.createElement("div");
    for (const count of [1, 2, 3, 4, 5]) {
      const images: ImageBlock[] = Array.from({ length: count }, (_, index) => ({
        url: `data:image/png;base64,image-${count}-${index}`,
        alt: `Image ${index + 1}`,
        width: count === 1 ? 16 : 640,
        height: count === 1 ? 16 : 640,
      }));
      render(renderMessageImages(images), container);
      const gallery = container.querySelector(".chat-message-images");
      expect(gallery?.classList.contains("chat-message-images--single")).toBe(count === 1);
      expect(gallery?.classList.contains("chat-message-images--gallery")).toBe(count > 1);
      expect(gallery?.classList.contains("chat-message-images--two-column")).toBe(
        count === 2 || count === 4,
      );
      expect(gallery?.classList.contains("chat-message-images--five")).toBe(count === 5);
      if (count === 1) {
        expect(container.querySelector(".chat-message-image--small")).not.toBeNull();
      }
    }
  });

  it("refreshes every split pane when a shared pairing QR expires", async () => {
    const expiresAt = Date.now() + 1_000;
    const refreshFirst = observeSubscriber(vi.fn());
    const refreshSecond = observeSubscriber(vi.fn());

    schedulePairingQrExpiryRefresh("shared-pairing-qr", expiresAt, refreshFirst);
    schedulePairingQrExpiryRefresh("shared-pairing-qr", expiresAt, refreshSecond);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refreshFirst).toHaveBeenCalledOnce();
    expect(refreshSecond).toHaveBeenCalledOnce();
  });

  it("releases a pairing QR expiry timer when its chat pane disconnects", async () => {
    const refresh = observeSubscriber(vi.fn());
    schedulePairingQrExpiryRefresh("disconnected-pairing-qr", Date.now() + 1_000, refresh);

    releaseChatMediaResourceSubscriber(refresh);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes a managed image after one transient failure without an external render", async () => {
    const source = managedImageSource();
    const blobUrl = installManagedImageUrls();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const rerender = observeSubscriber(() =>
      renderManagedImage(container, source, { onRequestUpdate: rerender }),
    );

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".chat-message-image")).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(blobUrl);
  });

  it("keeps a cached managed image mounted during rerenders and uses current callbacks", async () => {
    const source = managedImageSource();
    installManagedImageUrls();
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const container = document.body.appendChild(document.createElement("div"));
    const previousOpen = vi.fn<NonNullable<ImageRenderOptions["onOpenImage"]>>();
    const currentOpen = vi.fn<NonNullable<ImageRenderOptions["onOpenImage"]>>();
    onTestFinished(() => {
      for (const [item] of [...previousOpen.mock.calls, ...currentOpen.mock.calls]) {
        item.release?.();
      }
      render(null, container);
      container.remove();
    });
    renderManagedImage(container, source, {
      onRequestUpdate: observeSubscriber(vi.fn()),
      onOpenImage: previousOpen,
    });
    await vi.advanceTimersByTimeAsync(0);
    const displayed = container.querySelector(".chat-message-image");
    expect(displayed).not.toBeNull();

    renderManagedImage(container, source, {
      onRequestUpdate: observeSubscriber(vi.fn()),
      onOpenImage: currentOpen,
    });
    // A settled cache hit must not blank the native image for a promise turn.
    expect(container.querySelector(".chat-message-image")).toBe(displayed);
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector(".chat-message-image")).toBe(displayed);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    container.querySelector<HTMLButtonElement>(".chat-message-image-button")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(previousOpen).not.toHaveBeenCalled();
    expect(currentOpen).toHaveBeenCalledOnce();
  });

  it("stops after one automatic retry for a permanently unavailable managed image", async () => {
    const source = managedImageSource();
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const rerender = observeSubscriber(() =>
      renderManagedImage(container, source, { onRequestUpdate: rerender }),
    );

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector(".chat-message-image")).toBeNull();
  });

  it("preserves the bounded retry window when an image has no pane subscriber", async () => {
    const source = managedImageSource();
    const blobUrl = installManagedImageUrls();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    renderManagedImage(container, source);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    renderManagedImage(container, source);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(blobUrl);
  });

  it("releases replaced managed images while keeping one pane callback stable", async () => {
    const NativeUrl = URL;
    let blobIndex = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => `blob:replaced-managed-image-${blobIndex++}`);
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const firstSource = managedImageSource();
    const sources = [firstSource, ...Array.from({ length: 64 }, () => managedImageSource())];
    let currentSource = firstSource;
    const rerender = observeSubscriber(() =>
      renderManagedImage(container, currentSource, { onRequestUpdate: rerender }),
    );
    const resources = [];

    for (const source of sources) {
      currentSource = source;
      rerender();
      resources.push(
        observeChatMediaResource<string | null>("managed-image", managedImageResourceKey(source)),
      );
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(fetchMock).toHaveBeenCalledTimes(65);
    expect(resources.filter((resource) => isChatMediaResourceCurrent(resource))).toHaveLength(1);
    expect(resources.at(-1)).toSatisfy(isChatMediaResourceCurrent);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:replaced-managed-image-0");
  });

  it("keeps simultaneous managed images until their individual render parts disappear", async () => {
    installManagedImageUrls();
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const firstSource = managedImageSource();
    const secondSource = managedImageSource();
    let sources = [firstSource, secondSource];
    const rerender = observeSubscriber(() => {
      const images = sources.map((source) => ({
        url: source,
        displayUrl: source,
        alt: "Managed image",
      }));
      render(renderMessageImages(images, { onRequestUpdate: rerender }), container);
    });

    rerender();
    const firstResource = observeChatMediaResource<string | null>(
      "managed-image",
      managedImageResourceKey(firstSource),
    );
    const secondResource = observeChatMediaResource<string | null>(
      "managed-image",
      managedImageResourceKey(secondSource),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(isChatMediaResourceCurrent(firstResource)).toBe(true);
    expect(isChatMediaResourceCurrent(secondResource)).toBe(true);
    expect(container.querySelectorAll(".chat-message-image")).toHaveLength(2);

    sources = [firstSource];
    rerender();
    await vi.advanceTimersByTimeAsync(0);

    expect(isChatMediaResourceCurrent(firstResource)).toBe(true);
    expect(isChatMediaResourceCurrent(secondResource)).toBe(false);
    expect(container.querySelectorAll(".chat-message-image")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resubscribes a guarded managed image when its Lit root reconnects", async () => {
    const blobUrl = installManagedImageUrls();
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const source = managedImageSource();
    const image = { url: source, displayUrl: source, alt: "Managed image" };
    const renderImageRow = vi.fn(() => renderMessageImages([image], { onRequestUpdate: rerender }));
    let root!: ReturnType<typeof render>;
    const rerender = observeSubscriber(() => {
      root = render(html`${guard([source], renderImageRow)}`, container);
    });

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    const originalResource = observeChatMediaResource<string | null>(
      "managed-image",
      managedImageResourceKey(source),
    );
    expect(originalResource.subscribers.size).toBe(1);

    root.setConnected(false);
    expect(isChatMediaResourceCurrent(originalResource)).toBe(false);

    root.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);

    const reconnectedResource = observeChatMediaResource<string | null>(
      "managed-image",
      managedImageResourceKey(source),
    );
    expect(reconnectedResource.subscribers.size).toBe(1);
    expect(renderImageRow).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLImageElement>(".chat-message-image")?.src).toBe(blobUrl);
  });

  it("does not subscribe or fetch a managed image while its Lit root is disconnected", async () => {
    installManagedImageUrls();
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    let source = managedImageSource();
    let root!: ReturnType<typeof render>;
    const rerender = observeSubscriber(() => {
      const image = { url: source, displayUrl: source, alt: "Managed image" };
      root = render(
        html`${guard([source], () => renderMessageImages([image], { onRequestUpdate: rerender }))}`,
        container,
      );
    });

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    root.setConnected(false);
    source = managedImageSource();
    rerender();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    root.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".chat-message-image")).not.toBeNull();
  });

  it("evicts settled subscriber-free resources with their managed image blobs", async () => {
    const NativeUrl = URL;
    let blobIndex = 0;
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => `blob:bounded-managed-image-${blobIndex++}`);
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const sources = Array.from({ length: 65 }, () => managedImageSource());
    const resources = sources.map((source) => {
      renderManagedImage(document.createElement("div"), source);
      return observeChatMediaResource<string | null>(
        "managed-image",
        managedImageResourceKey(source),
      );
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(65);
    expect(resources.filter((resource) => isChatMediaResourceCurrent(resource))).toHaveLength(64);
    const oldestResource = resources[0];
    const oldestSource = sources[0];
    const latestSource = sources[64];
    if (!oldestResource || !oldestSource || !latestSource) {
      throw new Error("expected the oldest and newest managed images");
    }
    expect(isChatMediaResourceCurrent(oldestResource)).toBe(false);
    expect(readManagedImageBlobUrl(managedImageResourceKey(oldestSource))).toBeUndefined();
    expect(readManagedImageBlobUrl(managedImageResourceKey(latestSource))).toBe(
      "blob:bounded-managed-image-64",
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:bounded-managed-image-0");

    renderManagedImage(document.createElement("div"), latestSource);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(65);

    renderManagedImage(document.createElement("div"), oldestSource);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(66);
    expect(readManagedImageBlobUrl(managedImageResourceKey(oldestSource))).toBe(
      "blob:bounded-managed-image-65",
    );
  });

  it("shares a managed image retry and wakes both subscribed split panes", async () => {
    const source = managedImageSource();
    const blobUrl = installManagedImageUrls();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const first = document.createElement("div");
    const second = document.createElement("div");
    const rerenderFirst = observeSubscriber(() =>
      renderManagedImage(first, source, { onRequestUpdate: rerenderFirst }),
    );
    const rerenderSecond = observeSubscriber(() =>
      renderManagedImage(second, source, { onRequestUpdate: rerenderSecond }),
    );

    rerenderFirst();
    rerenderSecond();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src")).toBe(
      blobUrl,
    );
    expect(second.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src")).toBe(
      blobUrl,
    );
  });

  it("shares assistant attachment completion and ticket refresh across split panes", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "ticket-before-refresh",
          mediaTicketExpiresAt: new Date(Date.now() + 31_000).toISOString(),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "ticket-after-refresh",
          mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    let firstTicket: string | undefined;
    let secondTicket: string | undefined;
    const rerenderFirst = observeSubscriber(() => {
      const availability = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "split-pane-token",
        rerenderFirst,
      );
      firstTicket = availability.status === "available" ? availability.mediaTicket : undefined;
    });
    const rerenderSecond = observeSubscriber(() => {
      const availability = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "split-pane-token",
        rerenderSecond,
      );
      secondTicket = availability.status === "available" ? availability.mediaTicket : undefined;
    });

    rerenderFirst();
    rerenderSecond();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstTicket).toBe("ticket-before-refresh");
    expect(secondTicket).toBe("ticket-before-refresh");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstTicket).toBe("ticket-after-refresh");
    expect(secondTicket).toBe("ticket-after-refresh");
  });

  it("stops polling after a definitive ticket refresh rejection and one unavailable retry", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.mp3`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "ticket-before-definitive-rejection",
          mediaTicketExpiresAt: new Date(Date.now() + 31_000).toISOString(),
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ available: false, reason: "Attachment removed" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    let latest: ReturnType<typeof resolveAssistantAttachmentAvailability> | undefined;
    const rerender = observeSubscriber(() => {
      latest = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "definitive-rejection-token",
        rerender,
      );
    });

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(latest?.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(latest?.status).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds transient ticket refresh failures before using the unavailable retry", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.mp3`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "ticket-before-transient-failures",
          mediaTicketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      })
      .mockRejectedValueOnce(new Error("refresh unavailable 1"))
      .mockRejectedValueOnce(new Error("refresh unavailable 2"))
      .mockRejectedValueOnce(new Error("refresh unavailable 3"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ available: false }),
      });
    vi.stubGlobal("fetch", fetchMock);

    let latest: ReturnType<typeof resolveAssistantAttachmentAvailability> | undefined;
    const rerender = observeSubscriber(() => {
      latest = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "transient-refresh-token",
        rerender,
      );
    });

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(latest?.status).toBe("available");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(latest?.status).toBe("available");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(latest?.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(latest?.status).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("transitions an expired ticket to unavailable instead of retrying it", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.mp3`;
    const expiredAt = new Date(Date.now() + 31_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "ticket-that-will-expire",
          mediaTicketExpiresAt: expiredAt.toISOString(),
        }),
      })
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(expiredAt.getTime() + 1));
        throw new Error("refresh completed after ticket expiry");
      });
    vi.stubGlobal("fetch", fetchMock);

    let latest: ReturnType<typeof resolveAssistantAttachmentAvailability> | undefined;
    const rerender = observeSubscriber(() => {
      latest = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "expired-refresh-token",
        rerender,
      );
    });

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.status).toBe("unavailable");
  });

  it("shares the one bounded assistant attachment retry across split panes", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ available: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          available: true,
          mediaTicket: "ticket-after-retry",
          mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    let firstTicket: string | undefined;
    let secondTicket: string | undefined;
    const rerenderFirst = observeSubscriber(() => {
      const availability = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "split-pane-token",
        rerenderFirst,
      );
      firstTicket = availability.status === "available" ? availability.mediaTicket : undefined;
    });
    const rerenderSecond = observeSubscriber(() => {
      const availability = resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        "split-pane-token",
        rerenderSecond,
      );
      secondTicket = availability.status === "available" ? availability.mediaTicket : undefined;
    });

    rerenderFirst();
    rerenderSecond();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstTicket).toBe("ticket-after-retry");
    expect(secondTicket).toBe("ticket-after-retry");
  });

  it("aborts pending media and clears its retry when the last pane disconnects", async () => {
    const source = managedImageSource();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_source: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("pane disconnected", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const rerender = observeSubscriber(() =>
      renderManagedImage(container, source, { onRequestUpdate: rerender }),
    );

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    releaseChatMediaResourceSubscriber(rerender);
    await vi.advanceTimersByTimeAsync(0);

    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps shared image work alive until the last split pane disconnects", async () => {
    const source = managedImageSource();
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      (_source: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("last pane disconnected", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = document.createElement("div");
    const second = document.createElement("div");
    const rerenderFirst = observeSubscriber(() =>
      renderManagedImage(first, source, { onRequestUpdate: rerenderFirst }),
    );
    const rerenderSecond = observeSubscriber(() =>
      renderManagedImage(second, source, { onRequestUpdate: rerenderSecond }),
    );

    rerenderFirst();
    rerenderSecond();
    await vi.advanceTimersByTimeAsync(0);

    releaseChatMediaResourceSubscriber(rerenderFirst);
    expect(requestSignal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseChatMediaResourceSubscriber(rerenderSecond);
    await vi.advanceTimersByTimeAsync(0);

    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces an old auth scope without accepting its late image", async () => {
    const source = managedImageSource();
    const blobUrl = installManagedImageUrls();
    let previousSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_source: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get("Authorization") === "Bearer old-token") {
        return new Promise<Response>((_resolve, reject) => {
          previousSignal = init?.signal ?? undefined;
          previousSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("auth changed", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve(imageResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    let authToken = "old-token";
    const rerender = observeSubscriber(() =>
      renderManagedImage(container, source, { authToken, onRequestUpdate: rerender }),
    );

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    authToken = "new-token";
    rerender();
    await vi.advanceTimersByTimeAsync(0);

    expect(previousSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(blobUrl);
  });

  it("retries signed artifact tickets without exposing gateway or requester credentials", async () => {
    const source = managedImageSource();
    const artifactId = `artifact-${crypto.randomUUID()}`;
    const ticketedUrl = `${source}?mediaTicket=signed`;
    const blobUrl = installManagedImageUrls();
    const resolveArtifactDownload = vi.fn(async () => ({ url: ticketedUrl }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    const rerender = observeSubscriber(() =>
      renderManagedImage(
        container,
        source,
        {
          authToken: "must-never-be-forwarded",
          onRequestUpdate: rerender,
          resolveArtifactDownload,
        },
        artifactId,
      ),
    );

    rerender();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolveArtifactDownload).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [requestUrl, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(requestUrl).toBe(ticketedUrl.replace(/\/full(?=\?)/u, "/thumbnail"));
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("x-openclaw-requester-session-key")).toBeNull();
    }
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(blobUrl);
  });
});
