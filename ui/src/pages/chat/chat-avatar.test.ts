/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../../lib/identity-avatar-loader.ts";
import {
  invalidateChatAvatarCache,
  refreshChatAvatar,
  refreshSenderAgentAvatars,
  renderChatAvatar,
  renderForwardedAvatar,
} from "./chat-avatar.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { renderWelcomeState } from "./components/chat-welcome.ts";

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

  it("shares authenticated welcome and transcript avatars without an explicit token", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["device-token"]);
    const response = createDeferred<Response>();
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-agent");
    const container = document.createElement("div");
    const avatar = "/avatar/main?v=1";
    const welcome = (assistantAvatar: string | null, assistantAvatarUrl?: string) =>
      renderWelcomeState({
        assistantName: "Main",
        assistantAvatar,
        assistantAvatarUrl,
        onDraftChange: () => undefined,
        onSend: () => undefined,
      });
    const part = render(
      html`${welcome(avatar)}${welcome(null, avatar)}${renderChatAvatar("assistant", {
        avatar,
        name: "Main",
      })}`,
      container,
    );
    const sources = () =>
      [...container.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(sources()).toEqual([null, null, null]);
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      `https://gateway.example.test${avatar}`,
      expect.objectContaining({ headers: { Authorization: "Bearer device-token" } }),
    );
    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    await vi.waitFor(() => expect(sources()).toEqual(Array(3).fill("blob:shared-agent")));
    part.setConnected(false);
    part.setConnected(true);
    expect(sources()).toEqual(Array(3).fill("blob:shared-agent"));
    expect(fetchAvatar).toHaveBeenCalledOnce();
    render(nothing, container);
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

    for (const avatar of ["data:image/png;base64,YQ==", "/custom.svg"]) {
      const container = document.createElement("div");
      const part = render(renderChatAvatar("user", undefined, { name: "Buns", avatar }), container);
      part.setConnected(false);
      part.setConnected(true);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(avatar);
      render(nothing, container);
    }
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
  it("shares one authenticated avatar across retained chat panes", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["test-token"]);
    const first = makeChatHost({
      requestHandlers: {
        "agent.identity.get": { agentId: "main", name: "Main", avatar: "/avatar/main?v=1" },
      },
      settings: { token: "test-token" },
    });
    const second = makeChatHost({ client: first.client, settings: { token: "test-token" } });
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-avatar");
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    await Promise.all([refreshChatAvatar(first), refreshChatAvatar(second)]);
    expect(first.chatAvatarUrl).toBe("blob:shared-avatar");
    expect(second.chatAvatarUrl).toBe(first.chatAvatarUrl);
    expect(fetchAvatar).toHaveBeenCalledOnce();
    invalidateChatAvatarCache(first);
    expect(second.chatAvatarUrl).toBe("blob:shared-avatar");
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(second);
  });

  function avatarHost() {
    setAvatarGatewayOrigin("https://gateway.example.test", ["test-token"]);
    return makeChatHost({
      sessionKey: "agent:main:first",
      requestHandlers: {
        "agent.identity.get": ({ agentId }: { agentId: string }) => ({
          agentId,
          name: agentId,
          avatar: `/avatar/${agentId}?v=1`,
          avatarStatus: "local",
        }),
      },
    });
  }

  it("reuses the avatar through session changes and pane replacement", async () => {
    const host = avatarHost();
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:main-avatar");
    await refreshChatAvatar(host);
    host.sessionKey = "agent:main:second";
    const refresh = refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:main-avatar");
    await refresh;
    invalidateChatAvatarCache(host);
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:main-avatar");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(host.request).toHaveBeenCalledOnce();
  });

  it("replaces a revised avatar without revoking a retained sibling's image", async () => {
    const host = avatarHost();
    const identities = createAgentIdentityCapability({
      snapshot: { client: host.client, phase: "connected" },
      subscribe: () => () => undefined,
    });
    const sibling = makeChatHost({ client: host.client });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:old")
      .mockReturnValueOnce("blob:new");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await Promise.all([refreshChatAvatar(host), refreshChatAvatar(sibling)]);
    identities.invalidate(["main"]);
    host.request.mockResolvedValue({ agentId: "main", name: "Main", avatar: "/avatar/main?v=2" });
    const refresh = refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:old");
    await refresh;
    expect(host.chatAvatarUrl).toBe("blob:new");
    expect(sibling.chatAvatarUrl).toBe("blob:old");
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(host);
    invalidateChatAvatarCache(sibling);
  });

  it.each(["failed", "removed", "text", "gateway", "credentials"])(
    "keeps only same-context working avatars on a %s replacement",
    async (change) => {
      const host = avatarHost();
      const identities = createAgentIdentityCapability({
        snapshot: { client: host.client, phase: "connected" },
        subscribe: () => () => undefined,
      });
      const sibling = makeChatHost({ client: host.client });
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
        );
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:working-avatar");
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      await Promise.all([refreshChatAvatar(host), refreshChatAvatar(sibling)]);
      const replacement = {
        agentId: "main",
        name: "Main",
        avatar: change === "removed" ? "" : change === "text" ? "🦞" : "/avatar/main?v=2",
      };
      identities.invalidate(["main"]);
      host.request.mockResolvedValue(replacement);
      if (change === "gateway" || change === "credentials") {
        host.connected = false;
        sibling.connected = false;
        await Promise.all([refreshChatAvatar(host), refreshChatAvatar(sibling)]);
        setAvatarGatewayOrigin(
          change === "gateway"
            ? "https://replacement.example.test"
            : "https://gateway.example.test",
          ["replacement-token"],
        );
        host.client = makeChatHost({
          requestHandlers: { "agent.identity.get": replacement },
        }).client;
        host.connectionEpoch += 1;
        host.connected = true;
      }
      fetchAvatar.mockResolvedValue(new Response(null, { status: 503 }));
      await refreshChatAvatar(host);
      expect(host.chatAvatarUrl).toBe(change === "failed" ? "blob:working-avatar" : null);
      if (change === "gateway" || change === "credentials") {
        expect(sibling.chatAvatarUrl).toBeNull();
        expect(revoke).toHaveBeenCalledWith("blob:working-avatar");
        expect(fetchAvatar).toHaveBeenLastCalledWith(
          expect.stringContaining("/avatar/main?v=2"),
          expect.objectContaining({ headers: { Authorization: "Bearer replacement-token" } }),
        );
      } else {
        expect(sibling.chatAvatarUrl).toBe("blob:working-avatar");
        expect(revoke).not.toHaveBeenCalled();
      }
      invalidateChatAvatarCache(host);
      invalidateChatAvatarCache(sibling);
    },
  );

  it("lets the newest same-agent waiter apply a shared avatar fetch", async () => {
    const host = avatarHost();
    const response = createDeferred<Response>();
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-avatar");
    const first = refreshChatAvatar(host);
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
    host.sessionKey = "agent:main:second";
    const second = refreshChatAvatar(host);
    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    await Promise.all([first, second]);
    expect(host.chatAvatarUrl).toBe("blob:shared-avatar");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    invalidateChatAvatarCache(host);
  });

  it("keeps a live waiter's shared avatar when a stale waiter settles under cache pressure", async () => {
    const host = avatarHost();
    const avatar = createDeferred<Response>();
    const pressure = createDeferred<Response>();
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("/avatar/main?") ? avatar.promise : pressure.promise;
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:live-avatar");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const stale = refreshChatAvatar(host);
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
    const pressureLoads = Array.from({ length: 128 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/avatar/pending-${index}?v=1`)),
    );
    host.sessionKey = "agent:main:second";
    const current = refreshChatAvatar(host);
    avatar.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    try {
      await Promise.all([stale, current]);
      expect(host.chatAvatarUrl).toBe("blob:live-avatar");
      expect(revoke).not.toHaveBeenCalledWith("blob:live-avatar");
    } finally {
      pressure.resolve(new Response(null, { status: 404 }));
      await Promise.all(pressureLoads);
      invalidateChatAvatarCache(host);
    }
  });

  it.each(["session", "connection", "invalidation"])(
    "rejects a pending avatar after %s changes",
    async (change) => {
      const host = avatarHost();
      const response = createDeferred<Response>();
      const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:stale");
      const pending = refreshChatAvatar(host);
      await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
      if (change === "session") {
        host.sessionKey = "agent:other:main";
      }
      if (change === "connection") {
        host.connectionEpoch += 1;
      }
      if (change === "invalidation") {
        invalidateChatAvatarCache(host);
      }
      response.resolve(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
      await pending;
      expect(host.chatAvatarUrl).toBeNull();
    },
  );

  it.each(["response", "body"])(
    "bounds a stalled image %s by the shared deadline",
    async (phase) => {
      const host = avatarHost();
      const deadline = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (_input, init) =>
          phase === "response"
            ? pendingUntilAbort<Response>(init?.signal)
            : ({ ok: true, blob: () => pendingUntilAbort<Blob>(init?.signal) } as Response),
        );
      const pending = refreshChatAvatar(host);
      await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(30_000);
      deadline.abort();
      await pending;
      expect(host.chatAvatarUrl).toBeNull();
    },
  );

  it("keeps missing avatar diagnostics without fetching a remote source", async () => {
    const host = avatarHost();
    host.request.mockResolvedValue({
      agentId: "main",
      name: "Main",
      avatar: "https://example.com/avatar.png",
      avatarSource: "https://example.com/avatar.png",
      avatarStatus: "none",
      avatarReason: "missing",
    });
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("https://example.com/avatar.png");
    expect(host.chatAvatarReason).toBe("missing");
    expect(fetchAvatar).not.toHaveBeenCalled();
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
    setAvatarGatewayOrigin("https://gateway.example.test", ["test-token"]);
    return {
      ...makeChatHost({
        sessionKey: "agent:main:main",
        requestHandlers: {
          "agent.identity.get": ({ agentId }: { agentId: string }) => ({
            agentId,
            name: agentId,
            avatar: `/avatar/${agentId}?v=1`,
          }),
        },
      }),
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "research" }] },
      senderAgentAvatars: undefined as ReadonlyMap<string, string | null> | undefined,
    };
  }

  it.each([200, 404])(
    "keeps forwarded identity visible through pending and HTTP %s",
    async (status) => {
      const host = senderHost();
      const response = createDeferred<Response>();
      const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:forwarded-avatar");
      host.chatMessages = forwardedMessages("research");
      const pending = refreshSenderAgentAvatars(host);
      await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
      const container = document.createElement("div");
      const renderSender = () =>
        render(
          renderForwardedAvatar("research", {
            agentId: "main",
            agents: host.agentsList.agents,
            senderAgentAvatars: host.senderAgentAvatars,
          }),
          container,
        );
      renderSender();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe(
        "R",
      );
      expect(fetchAvatar).toHaveBeenCalledWith(
        "https://gateway.example.test/avatar/research?v=1",
        expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
      );
      response.resolve(
        status === 200
          ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
          : new Response(null, { status }),
      );
      await pending;
      renderSender();
      if (status === 200) {
        expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:forwarded-avatar");
        expect(container.querySelector(".chat-avatar--sender-initials")).toBeNull();
      } else {
        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector(".chat-avatar--sender-initials")?.textContent?.trim()).toBe(
          "R",
        );
      }
      render(nothing, container);
      invalidateChatAvatarCache(host);
    },
  );

  it("shares sender snapshots with the current-agent cache and skips unknown agents", async () => {
    const host = senderHost();
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:research-avatar");
    host.chatMessages = forwardedMessages("main", "unknown", "research", "research");
    await Promise.all([refreshSenderAgentAvatars(host), refreshSenderAgentAvatars(host)]);
    expect(host.senderAgentAvatars).toEqual(new Map([["research", "blob:research-avatar"]]));
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/avatar/research?v=1",
      expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
    );
    host.sessionKey = "agent:research:main";
    await refreshChatAvatar(host);
    expect(host.chatAvatarUrl).toBe("blob:research-avatar");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    invalidateChatAvatarCache(host);
  });

  it.each(["failed", "removed", "text"])(
    "preserves forwarded-avatar ownership on a %s replacement",
    async (change) => {
      const host = senderHost();
      const identities = createAgentIdentityCapability({
        snapshot: { client: host.client, phase: "connected" },
        subscribe: () => () => undefined,
      });
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () =>
            new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
        );
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:working-forward");
      host.chatMessages = forwardedMessages("research");
      await refreshSenderAgentAvatars(host);
      identities.invalidate(["research"]);
      host.request.mockResolvedValue({
        agentId: "research",
        name: "Research",
        avatar: change === "removed" ? "" : change === "text" ? "🦞" : "/avatar/research?v=2",
      });
      fetchAvatar.mockResolvedValue(new Response(null, { status: 503 }));
      host.chatMessages = forwardedMessages("research");
      await refreshSenderAgentAvatars(host);
      expect(host.senderAgentAvatars?.get("research")).toBe(
        change === "failed" ? "blob:working-forward" : null,
      );
      host.connected = false;
      await refreshSenderAgentAvatars(host);
      expect(host.senderAgentAvatars?.size).toBe(0);
      invalidateChatAvatarCache(host);
    },
  );

  it("loads newly committed forwards and releases cleared senders", async () => {
    const host = { ...senderHost(), requestUpdate: vi.fn() };
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:forwarded");
    await refreshSenderAgentAvatars(host);
    expect(fetchAvatar).not.toHaveBeenCalled();
    host.chatMessages = forwardedMessages("research");
    await refreshSenderAgentAvatars(host);
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:forwarded");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(host.requestUpdate).toHaveBeenCalledOnce();
    host.chatMessages = [];
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.size).toBe(0);
    invalidateChatAvatarCache(host);
  });

  it("retires a forwarded batch across invalidation without releasing its replacement", async () => {
    const host = senderHost();
    const identities = createAgentIdentityCapability({
      snapshot: { client: host.client, phase: "connected" },
      subscribe: () => () => undefined,
    });
    const oldResponse = createDeferred<Response>();
    const imageResponse = () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(imageResponse())
      .mockImplementation(async () => new Response(null, { status: 404 }));
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:new-forward")
      .mockReturnValueOnce("blob:old-forward");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    host.chatMessages = forwardedMessages("research");
    const older = refreshSenderAgentAvatars(host);
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());

    identities.invalidate(["research"]);
    invalidateChatAvatarCache(host);
    host.request.mockResolvedValue({ agentId: "research", avatar: "/avatar/research?v=2" });
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:new-forward");
    oldResponse.resolve(imageResponse());
    await older;
    expect(host.senderAgentAvatars?.get("research")).toBe("blob:new-forward");

    for (let index = 0; index < 128; index += 1) {
      await resolveAvatarImageUrl(`/avatar/pressure-${index}`);
    }
    expect(revoke).toHaveBeenCalledWith("blob:old-forward");
    expect(revoke).not.toHaveBeenCalledWith("blob:new-forward");
    invalidateChatAvatarCache(host);
    await resolveAvatarImageUrl("/avatar/after-release");
    expect(revoke).toHaveBeenCalledWith("blob:new-forward");
  });

  it.each(["session", "request", "connection", "roster", "invalidation"])(
    "does not publish a sender avatar after its %s changes",
    async (change) => {
      const host = senderHost();
      const response = createDeferred<Response>();
      const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:stale");
      host.chatMessages = forwardedMessages("research");
      const pending = refreshSenderAgentAvatars(host);
      await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
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
      response.resolve(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
      await pending;
      expect(host.senderAgentAvatars?.size ?? 0).toBe(0);
    },
  );

  it("bounds sender loads without revoking the current agent's blob", async () => {
    const host = senderHost();
    const agents = Array.from({ length: 30 }, (_, i) => ({ id: `sender-${i}` }));
    host.agentsList.agents.push(...agents);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      );
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:avatar-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await refreshChatAvatar(host);
    const current = host.chatAvatarUrl;
    expect(current).toBe("blob:avatar-0");
    host.chatMessages = forwardedMessages(...agents.map((agent) => agent.id));
    await refreshSenderAgentAvatars(host);
    expect(host.senderAgentAvatars?.size).toBe(23);
    expect(
      [...host.senderAgentAvatars!.values()].every((url) => url?.startsWith("blob:avatar-")),
    ).toBe(true);
    expect(fetchAvatar).toHaveBeenCalledTimes(24);
    expect(host.chatAvatarUrl).toBe(current);
    expect(revoke).not.toHaveBeenCalled();
    invalidateChatAvatarCache(host);
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

    render(renderChatAvatar("user", undefined, undefined, "", firstSender), container);
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
      renderChatAvatar("user", undefined, undefined, "", {
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
      renderChatAvatar("user", undefined, undefined, "", {
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
      render(renderChatAvatar("user", undefined, undefined, "", sender), container);

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
