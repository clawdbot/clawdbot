/* @vitest-environment jsdom */

import { html, render } from "lit";
import { guard } from "lit/directives/guard.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachments.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import {
  isChatMediaResourceCurrent,
  observeChatMediaResource,
  readManagedImageBlobUrl,
  releaseChatMediaResourceSubscriber,
  type ImageRenderOptions,
  type RenderableImageBlock,
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
  const image: RenderableImageBlock = {
    url: source,
    displayUrl: source,
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
      resources.push(observeChatMediaResource<string | null>("managed-image", `${source}::::`));
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
      `${firstSource}::::`,
    );
    const secondResource = observeChatMediaResource<string | null>(
      "managed-image",
      `${secondSource}::::`,
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
      `${source}::::`,
    );
    expect(originalResource.subscribers.size).toBe(1);

    root.setConnected(false);
    expect(isChatMediaResourceCurrent(originalResource)).toBe(false);

    root.setConnected(true);
    await vi.advanceTimersByTimeAsync(0);

    const reconnectedResource = observeChatMediaResource<string | null>(
      "managed-image",
      `${source}::::`,
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
      return observeChatMediaResource<string | null>("managed-image", `${source}::::`);
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
    expect(readManagedImageBlobUrl(`${oldestSource}::::`)).toBeUndefined();
    expect(readManagedImageBlobUrl(`${latestSource}::::`)).toBe("blob:bounded-managed-image-64");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:bounded-managed-image-0");

    renderManagedImage(document.createElement("div"), latestSource);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(65);

    renderManagedImage(document.createElement("div"), oldestSource);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(66);
    expect(readManagedImageBlobUrl(`${oldestSource}::::`)).toBe("blob:bounded-managed-image-65");
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
        ["/tmp/openclaw"],
        "/openclaw",
        "split-pane-token",
        rerenderFirst,
      );
      firstTicket = availability.status === "available" ? availability.mediaTicket : undefined;
    });
    const rerenderSecond = observeSubscriber(() => {
      const availability = resolveAssistantAttachmentAvailability(
        source,
        ["/tmp/openclaw"],
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
        ["/tmp/openclaw"],
        "/openclaw",
        "split-pane-token",
        rerenderFirst,
      );
      firstTicket = availability.status === "available" ? availability.mediaTicket : undefined;
    });
    const rerenderSecond = observeSubscriber(() => {
      const availability = resolveAssistantAttachmentAvailability(
        source,
        ["/tmp/openclaw"],
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
      expect(requestUrl).toBe(ticketedUrl);
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("x-openclaw-requester-session-key")).toBeNull();
    }
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(blobUrl);
  });
});
