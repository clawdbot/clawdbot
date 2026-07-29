/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar.ts";
import { invalidateChatAvatarCache, refreshChatAvatar, renderChatAvatar } from "./chat-avatar.ts";

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
  setAvatarGatewayOrigin(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("reuses the same-agent avatar without clearing or refetching it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ avatarUrl: "/avatar/main", avatarStatus: "local" }),
      })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:main-avatar");

    const host = createHost();
    host.sessionKey = "agent:main:first";
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:main-avatar");

    host.sessionKey = "agent:main:second";
    const refresh = refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:main-avatar");
    await refresh;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.chatAvatarUrl).toBe("blob:main-avatar");
  });

  it("keeps an expired same-agent avatar visible while refreshing it", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ avatarUrl: "/avatar/main", avatarStatus: "local" }),
      })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["first"]) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ avatarUrl: "/avatar/main", avatarStatus: "local" }),
      })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["second"]) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-avatar")
      .mockReturnValueOnce("blob:second-avatar");

    const host = createHost();
    host.sessionKey = "agent:main:first";
    await refreshChatAvatar(host);
    now.mockReturnValue(61_001);
    host.sessionKey = "agent:main:second";

    const refresh = refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:first-avatar");
    await refresh;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(host.chatAvatarUrl).toBe("blob:second-avatar");
  });

  it("restores an expired avatar after a failed refresh and retries it", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["first"]) })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["second"]) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-avatar")
      .mockReturnValueOnce("blob:second-avatar");
    const host = createHost();

    await refreshChatAvatar(host);
    now.mockReturnValue(61_001);
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:first-avatar");

    await refreshChatAvatar(host);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(host.chatAvatarUrl).toBe("blob:second-avatar");
  });

  it("lets the newest same-agent waiter apply a shared avatar fetch", async () => {
    let resolveBlob: (blob: Blob) => void = () => undefined;
    const blob = new Promise<Blob>((resolve) => {
      resolveBlob = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => await blob });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-avatar");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    const host = createHost();
    host.sessionKey = "agent:main:first";

    const first = refreshChatAvatar(host);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    host.sessionKey = "agent:main:second";
    const second = refreshChatAvatar(host);
    resolveBlob(new Blob(["avatar"]));
    await Promise.all([first, second]);

    expect(host.chatAvatarUrl).toBe("blob:shared-avatar");
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("retries a failed local avatar download", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["avatar"]) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retried-avatar");
    const host = createHost();

    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBeNull();
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(host.chatAvatarUrl).toBe("blob:retried-avatar");
  });

  it("invalidates a cached avatar before configuration refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["first"]) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ avatarUrl: "/avatar/main" }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["second"]) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-avatar")
      .mockReturnValueOnce("blob:second-avatar");
    const host = createHost();

    await refreshChatAvatar(host);
    invalidateChatAvatarCache(host);
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(host.chatAvatarUrl).toBe("blob:second-avatar");
  });
});

describe("attributed sender avatars", () => {
  it("restores pending initials when the authenticated sender avatar changes", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", "Bearer profile-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first-sender")
      .mockReturnValueOnce("blob:second-sender");
    const container = document.createElement("div");
    const firstSender = {
      id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
      name: "Ada Lovelace",
      profileAvatarUrl: "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar?v=1",
    };

    render(renderChatAvatar("user", undefined, undefined, "", null, firstSender), container);
    const firstImage = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".chat-avatar-slot img");
      expect(image?.getAttribute("src")).toBe("blob:first-sender");
      return image!;
    });
    firstImage.dispatchEvent(new Event("load"));
    expect(container.querySelector(".chat-avatar-slot")?.classList.contains("is-fallback")).toBe(
      false,
    );

    render(
      renderChatAvatar("user", undefined, undefined, "", null, {
        ...firstSender,
        profileAvatarUrl: "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar?v=2",
      }),
      container,
    );
    expect(container.querySelector(".chat-avatar-slot")?.classList.contains("is-fallback")).toBe(
      true,
    );
    const secondImage = await vi.waitFor(() => {
      const image = container.querySelector<HTMLImageElement>(".chat-avatar-slot img");
      expect(image?.getAttribute("src")).toBe("blob:second-sender");
      return image!;
    });
    expect(secondImage).toBe(firstImage);
    secondImage.dispatchEvent(new Event("load"));
    expect(container.querySelector(".chat-avatar-slot")?.classList.contains("is-fallback")).toBe(
      false,
    );
  });

  it("renders the sender's profile avatar route for user messages", () => {
    const avatar = renderAvatar([
      "user",
      undefined,
      { name: "Viewer", avatar: null },
      "",
      null,
      { id: "c3e32452-0467-47e5-aafa-233cd5dae29f", name: "steipete" },
    ]);
    expect(avatar?.tagName).toBe("IMG");
    expect(avatar?.getAttribute("src")).toBe(
      "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar",
    );
    expect(avatar?.getAttribute("alt")).toBe("steipete");
  });

  it("renders identity-colored initials when the sender has no profile route", () => {
    const avatar = renderAvatar([
      "user",
      undefined,
      { name: "Viewer", avatar: null },
      "",
      null,
      { id: "alice@example.com", name: "Alice Lovelace" },
    ]);
    expect(avatar?.tagName).toBe("DIV");
    expect(avatar?.classList.contains("chat-avatar--sender-initials")).toBe(true);
    expect(avatar?.textContent?.trim()).toBe("AL");
  });

  it("keeps the local viewer identity when no sender is attributed", () => {
    const avatar = renderAvatar(["user", undefined, { name: "Viewer", avatar: null }, "", null]);
    expect(avatar?.classList.contains("chat-avatar--sender-initials")).toBe(false);
  });

  it("swaps to identity initials when the derived avatar route errors", () => {
    const container = document.createElement("div");
    render(
      renderChatAvatar("user", undefined, undefined, "", null, {
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
        name: "steipete",
      }),
      container,
    );
    const slot = container.querySelector<HTMLElement>(".chat-avatar-slot");
    const image = slot?.querySelector("img");
    expect(image).not.toBeNull();
    expect(slot?.classList.contains("is-fallback")).toBe(false);

    image?.dispatchEvent(new Event("error"));
    expect(slot?.classList.contains("is-fallback")).toBe(true);
    expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("S");

    // A later successful load for a reused DOM part clears the error state.
    image?.dispatchEvent(new Event("load"));
    expect(slot?.classList.contains("is-fallback")).toBe(false);
  });
});
