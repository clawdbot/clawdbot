/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import {
  invalidateChatAvatarCache,
  refreshChatAvatar,
  refreshSenderAgentAvatars,
  renderChatAvatar,
} from "./chat-avatar.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

function renderAvatar(params: Parameters<typeof renderChatAvatar>) {
  const container = document.createElement("div");
  render(renderChatAvatar(...params), container);
  return container.querySelector<HTMLElement>(".chat-avatar");
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
    expect(defaultAvatar?.classList.contains("chat-avatar--logo")).toBe(true);

    const remoteAvatar = renderAvatar([
      "assistant",
      { avatar: "https://example.com/avatar.png", name: "Val" },
    ]);
    expect(remoteAvatar?.getAttribute("src")).toBe("/apple-touch-icon.png");
    expect(remoteAvatar?.classList.contains("chat-avatar--logo")).toBe(true);

    const blobAvatar = renderAvatar(["assistant", { avatar: "blob:managed-image", name: "Val" }]);
    expect(blobAvatar?.tagName).toBe("IMG");
    expect(blobAvatar?.getAttribute("src")).toBe("blob:managed-image");
    expect(blobAvatar?.classList.contains("chat-avatar--logo")).toBe(false);

    const textAvatar = renderAvatar(["assistant", { avatar: "VC", name: "Val" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("VC");
    expect(textAvatar?.getAttribute("aria-label")).toBe("Val");
    // aria-label on a role-less div is ignored by AT; role="img" makes the
    // name win over the raw initials text.
    expect(textAvatar?.getAttribute("role")).toBe("img");
    expect(textAvatar?.classList.contains("chat-avatar--logo")).toBe(false);

    const localAvatar = renderAvatar(["assistant", { avatar: "/avatar/main", name: "OpenClaw" }]);
    expect(localAvatar?.getAttribute("src")).toBe("/avatar/main");
    expect(localAvatar?.classList.contains("chat-avatar--logo")).toBe(false);
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
    expect(avatar?.classList.contains("chat-avatar--logo")).toBe(true);
  });

  it("renders local user image and text avatars", () => {
    const imageAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "/avatar/user" }]);
    expect(imageAvatar?.getAttribute("src")).toBe("/avatar/user");
    expect(imageAvatar?.getAttribute("alt")).toBe("Buns");
    expect(imageAvatar?.classList.contains("chat-avatar--logo")).toBe(false);

    const textAvatar = renderAvatar(["user", undefined, { name: "Buns", avatar: "AB" }]);
    expect(textAvatar?.tagName).toBe("DIV");
    expect(textAvatar?.textContent?.trim()).toBe("AB");
    expect(textAvatar?.classList.contains("chat-avatar--logo")).toBe(false);
  });

  it("swaps a failing local user image to initials instead of a broken image", () => {
    const container = document.createElement("div");
    const renderUser = () =>
      render(
        renderChatAvatar("user", undefined, { name: "Buns", avatar: "/avatar/user" }),
        container,
      );
    renderUser();
    const slot = container.querySelector<HTMLElement>(".chat-avatar-slot");
    const image = slot?.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/avatar/user");
    expect(slot?.classList.contains("is-fallback")).toBe(false);

    image?.dispatchEvent(new Event("error"));
    expect(slot?.classList.contains("is-fallback")).toBe(true);
    expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("B");

    renderUser();
    expect(slot?.classList.contains("is-fallback")).toBe(true);
    expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("B");
  });

  it("retains missing profile initials across rerenders and loads a new revision", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const gatewayOrigin = globalThis.location.origin;
    setAvatarGatewayOrigin(gatewayOrigin);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    const container = document.createElement("div");
    const avatarUrl = "/api/users/dd7c98e2-f51d-4590-b588-fa0682e165b7/avatar?v=7";
    const renderUser = (avatar = avatarUrl) =>
      render(renderChatAvatar("user", undefined, { name: "Hannah", avatar }), container);

    renderUser();
    const slot = container.querySelector<HTMLElement>(".chat-avatar-slot");
    const image = slot?.querySelector("img");
    expect(slot?.classList.contains("is-fallback")).toBe(true);
    expect(image?.hasAttribute("src")).toBe(false);
    expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("H");
    await expect(resolveAvatarImageUrl(avatarUrl)).resolves.toBeNull();
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      `${gatewayOrigin}${avatarUrl}`,
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );
    expect(image?.hasAttribute("src")).toBe(false);

    for (let renderIndex = 0; renderIndex < 3; renderIndex += 1) {
      setAvatarGatewayOrigin(gatewayOrigin);
      renderUser();
      await expect(resolveAvatarImageUrl(avatarUrl)).resolves.toBeNull();
      expect(fetchAvatar).toHaveBeenCalledOnce();
      expect(slot?.classList.contains("is-fallback")).toBe(true);
      expect(image?.hasAttribute("src")).toBe(false);
      expect(slot?.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("H");
    }

    fetchAvatar.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:uploaded-profile");
    renderUser("/api/users/dd7c98e2-f51d-4590-b588-fa0682e165b7/avatar?v=8");
    await vi.waitFor(() => expect(image?.getAttribute("src")).toBe("blob:uploaded-profile"));
    image?.dispatchEvent(new Event("load"));
    expect(slot?.classList.contains("is-fallback")).toBe(false);
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });
});

describe("refreshChatAvatar", () => {
  it("aborts a stalled metadata fetch at the deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      pendingUntilAbort<Response>(init?.signal),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeChatHost({ basePath: "/focus", resourceBasePath: "" });
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

    const host = makeChatHost();
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

    const host = makeChatHost();
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

    const host = makeChatHost();
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
    const host = makeChatHost();

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
    const host = makeChatHost();
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
    const host = makeChatHost();

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
    const host = makeChatHost();

    await refreshChatAvatar(host);
    invalidateChatAvatarCache(host);
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(host.chatAvatarUrl).toBe("blob:second-avatar");
  });
});

describe("refreshSenderAgentAvatars", () => {
  function forwardedMessages(...agentIds: string[]) {
    return agentIds.map((agentId) => ({
      role: "assistant",
      content: "report",
      senderSession: { agentId },
    }));
  }
  function senderHost() {
    return {
      ...makeChatHost({ sessionKey: "agent:main:main", settings: { token: "test-token" } }),
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "research" }] },
      senderAgentAvatars: undefined as ReadonlyMap<string, string | null> | undefined,
    };
  }

  it("shares authenticated sender snapshots with the current-agent cache and skips unknown agents", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ avatarUrl: "/avatar/research" })))
      .mockResolvedValueOnce(new Response(new Blob(["avatar"])));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:research-avatar");
    const host = senderHost();

    host.chatMessages = forwardedMessages("main", "unknown", "research", "research");
    await Promise.all([refreshSenderAgentAvatars(host), refreshSenderAgentAvatars(host)]);
    expect(host.senderAgentAvatars).toEqual(new Map([["research", "blob:research-avatar"]]));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/avatar/research?meta=1",
      "/avatar/research",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toEqual({ Authorization: "Bearer test-token" });
    }
    host.sessionKey = "agent:research:main";
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:research-avatar");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    invalidateChatAvatarCache(host);
    expect(host.senderAgentAvatars).toBeUndefined();
  });

  it("loads newly committed forwards and refreshes them after cache invalidation", async () => {
    const avatarUrl = "data:image/png;base64,YQ==";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ avatarUrl })));
    const host = { ...senderHost(), requestUpdate: vi.fn() };
    await refreshSenderAgentAvatars(host);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.requestUpdate).not.toHaveBeenCalled();

    host.chatMessages = [
      { role: "assistant", content: "report", senderSession: { agentId: "research" } },
    ];
    await refreshSenderAgentAvatars(host);
    await vi.waitFor(() => expect(host.senderAgentAvatars?.get("research")).toBe(avatarUrl));
    await refreshSenderAgentAvatars(host);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(host.requestUpdate).toHaveBeenCalledOnce();

    invalidateChatAvatarCache(host);
    await refreshSenderAgentAvatars(host);
    await vi.waitFor(() => expect(host.senderAgentAvatars?.get("research")).toBe(avatarUrl));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    host.chatMessages = [];
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.size).toBe(0);
    invalidateChatAvatarCache(host);
  });

  it.each(["session", "request", "connection", "roster", "invalidation"])(
    "does not publish a sender avatar after its %s changes",
    async (change) => {
      const response = createDeferred<Response>();
      vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
      const host = senderHost();
      host.chatMessages = forwardedMessages("research");
      const pending = refreshSenderAgentAvatars(host);
      if (change === "session") {
        host.sessionKey = "agent:main:other";
      }
      if (change === "request") {
        host.chatMessages = [];
        await refreshSenderAgentAvatars(host);
      }
      if (change === "connection") {
        host.connectionEpoch += 1;
      }
      if (change === "roster") {
        host.agentsList = { defaultId: "main", agents: [{ id: "main" }] };
      }
      if (change === "invalidation") {
        invalidateChatAvatarCache(host);
      }
      response.resolve(new Response(JSON.stringify({ avatarUrl: "data:image/png;base64,YQ==" })));
      await pending;
      expect(host.senderAgentAvatars?.size ?? 0).toBe(0);
    },
  );

  it("bounds sender loads without evicting the current agent's blob", async () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `sender-${i}` }));
    const host = senderHost();
    host.agentsList.agents.push(...agents);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("?meta=1")
        ? new Response(JSON.stringify({ avatarUrl: url.replace("?meta=1", "") }))
        : new Response(new Blob(["avatar"]));
    });
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:avatar-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await refreshChatAvatar(host);
    const currentAvatar = host.chatAvatarUrl;
    host.chatMessages = forwardedMessages(...agents.map((agent) => agent.id));
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.size).toBe(23);
    expect(fetchMock).toHaveBeenCalledTimes(48);
    expect(host.chatAvatarUrl).toBe(currentAvatar);
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(host);
    expect(revoke).toHaveBeenCalledTimes(24);
  });
});

describe("attributed sender avatars", () => {
  it("restores pending initials when the authenticated sender avatar changes", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
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
      {
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
        identity: { type: "profile", id: "c3e32452-0467-47e5-aafa-233cd5dae29f" },
        name: "steipete",
      },
    ]);
    expect(avatar?.tagName).toBe("IMG");
    expect(avatar?.getAttribute("src")).toBe(
      "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar",
    );
    expect(avatar?.getAttribute("alt")).toBe("steipete");
  });

  it.each(["alice@example.com", "c3e32452-0467-47e5-aafa-233cd5dae29f"])(
    "renders identity-colored initials for unqualified sender %s",
    (id) => {
      const avatar = renderAvatar([
        "user",
        undefined,
        { name: "Viewer", avatar: null },
        "",
        null,
        { id, name: "Alice Lovelace" },
      ]);
      expect(avatar?.tagName).toBe("DIV");
      expect(avatar?.classList.contains("chat-avatar--sender-initials")).toBe(true);
      expect(avatar?.textContent?.trim()).toBe("AL");
    },
  );

  it("keeps the local viewer identity when no sender is attributed", () => {
    const avatar = renderAvatar(["user", undefined, { name: "Viewer", avatar: null }, "", null]);
    expect(avatar?.classList.contains("chat-avatar--sender-initials")).toBe(false);
  });

  it("swaps to identity initials when the derived avatar route errors", () => {
    const container = document.createElement("div");
    render(
      renderChatAvatar("user", undefined, undefined, "", null, {
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
        identity: { type: "profile", id: "c3e32452-0467-47e5-aafa-233cd5dae29f" },
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

  it("keeps a missing same-origin sender avatar on initials across rerenders", async () => {
    const gatewayOrigin = globalThis.location.origin;
    setAvatarGatewayOrigin(gatewayOrigin);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    const container = document.createElement("div");
    const sender = {
      id: "dd7c98e2-f51d-4590-b588-fa0682e165b7",
      identity: { type: "profile" as const, id: "dd7c98e2-f51d-4590-b588-fa0682e165b7" },
      name: "hrudolph",
    };
    const renderSender = () =>
      render(renderChatAvatar("user", undefined, undefined, "", null, sender), container);

    renderSender();
    expect(container.querySelector(".chat-avatar-slot")?.classList.contains("is-fallback")).toBe(
      true,
    );
    expect(container.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("H");
    await vi.waitFor(() => {
      expect(fetchAvatar).toHaveBeenCalledOnce();
      expect(container.querySelector(".chat-avatar-slot img")?.hasAttribute("src")).toBe(false);
    });
    expect(fetchAvatar).toHaveBeenCalledWith(
      `${gatewayOrigin}/api/users/${sender.id}/avatar`,
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );

    renderSender();
    expect(container.querySelector(".chat-avatar-slot")?.classList.contains("is-fallback")).toBe(
      true,
    );
    expect(container.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe("H");
  });
});
