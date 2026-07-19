/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshChatAvatar, renderChatAvatar } from "./chat-avatar.ts";

function renderAvatar(params: Parameters<typeof renderChatAvatar>) {
  const container = document.createElement("div");
  render(renderChatAvatar(...params), container);
  return container.querySelector<HTMLElement>(".chat-avatar");
}

function createHost(): Parameters<typeof refreshChatAvatar>[0] {
  return {
    basePath: "",
    chatAvatarUrl: null,
    connected: true,
    hello: null,
    sessionKey: "agent:main",
  };
}

function pendingUntilAbort<T>(signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) {
    throw new Error("expected avatar fetch signal");
  }
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error("avatar fetch aborted"));
      },
      { once: true },
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("renderChatAvatar", () => {
  it("renders assistant fallback, blob image, and text avatars", () => {
    const defaultAvatar = renderAvatar(["assistant"]);
    expect(defaultAvatar?.getAttribute("src")).toBe("/apple-touch-icon.png");

    const remoteAvatar = renderAvatar([
      "assistant",
      { avatar: "https://example.com/avatar.png", name: "Val" },
    ]);
    expect(remoteAvatar?.getAttribute("src")).toBe("/apple-touch-icon.png");

    const blobAvatar = renderAvatar(["assistant", { avatar: "blob:managed-image", name: "Val" }]);
    expect(blobAvatar?.tagName).toBe("IMG");
    expect(blobAvatar?.getAttribute("src")).toBe("blob:managed-image");

    const textAvatar = renderAvatar(["assistant", { avatar: "VC", name: "Val" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("VC");
    expect(textAvatar?.getAttribute("aria-label")).toBe("Val");
  });

  it("uses the assistant fallback while authenticated avatar routes are loading", () => {
    const avatar = renderAvatar([
      "assistant",
      { avatar: "/avatar/main", name: "OpenClaw" },
      undefined,
      "",
      "session-token",
    ]);

    expect(avatar?.getAttribute("src")).toBe("/apple-touch-icon.png");
  });

  it("renders local user image and text avatars", () => {
    const imageAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "/avatar/user" }]);
    expect(imageAvatar?.getAttribute("src")).toBe("/avatar/user");
    expect(imageAvatar?.getAttribute("alt")).toBe("Buns");

    const textAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "AB" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("AB");
  });
});

describe("refreshChatAvatar", () => {
  it("aborts a stalled metadata fetch at the deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      pendingUntilAbort<Response>(init?.signal),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = createHost();
    const refresh = refreshChatAvatar(host);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);

    await expect(refresh).resolves.toBeUndefined();
    expect(host.chatAvatarUrl).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the image body read bounded by its own deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ avatarUrl: "/avatar/main" }),
      })
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          blob: () => pendingUntilAbort<Blob>(init?.signal),
        }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = createHost();
    const refresh = refreshChatAvatar(host);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const metadataSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal | undefined;
    const imageSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal | undefined;
    expect(metadataSignal).not.toBe(imageSignal);
    expect(metadataSignal?.aborted).toBe(false);
    expect(imageSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(imageSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(imageSignal?.aborted).toBe(true);

    await expect(refresh).resolves.toBeUndefined();
    expect(host.chatAvatarUrl).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
