/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountChatPaneHeader, type ChatPaneHeaderProps } from "./chat-pane-header.test-support.ts";
import { renderChatPaneHeader } from "./chat-pane-header.ts";

const containers: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  containers.splice(0).forEach((container) => container.remove());
});

function mountHeader(patch: Partial<ChatPaneHeaderProps> = {}) {
  return mountChatPaneHeader(containers, patch);
}

describe("chat pane workspace chip icon", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockWorkspaceIconRoute(routeUrl = "/__openclaw__/workspace-icon/agent%3Amain%3Aone") {
    const originalFetch = globalThis.fetch;
    const routeFetch = vi.fn<typeof fetch>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      input === routeUrl ? routeFetch(input, init) : originalFetch(input, init),
    );
    return routeFetch;
  }

  async function mountChip(workspaceIcon: ChatPaneHeaderProps["workspaceIcon"]) {
    const { container } = mountHeader({ workspaceIcon });
    const element = container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;
    await element?.updateComplete;
    return { container, element };
  }

  it("keeps the folder glyph when the gateway resolved no project icon", async () => {
    const { container, element } = await mountChip(null);
    expect(element).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("keeps the folder glyph while credentials are not ready", async () => {
    const fetchSpy = mockWorkspaceIconRoute();
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: [],
      authReady: false,
    });
    expect(element).not.toBeNull();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the folder glyph when the icon route fails", async () => {
    const fetchSpy = mockWorkspaceIconRoute().mockRejectedValue(
      new Error("workspace icon unavailable"),
    );
    const { container } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();
  });

  it("recovers the workspace icon after a transient route timeout", async () => {
    vi.useFakeTimers();
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const routeUrl = "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering";
    const fetchSpy = mockWorkspaceIconRoute(routeUrl)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({ "retry-after": "1" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recovered-workspace-icon");
    try {
      const { container, element } = await mountChip({
        routeUrl,
        authTokens: ["token"],
        authReady: true,
      });
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(container.querySelector(".workspace-icon")).toBeNull();
      expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();

      // Header chrome can fetch a system SVG while the protected route backs off.
      const chromeIcon = document.createElement("wa-icon");
      chromeIcon.setAttribute(
        "src",
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><title>recovery chrome</title></svg>',
      );
      container.append(chromeIcon);
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await element?.updateComplete;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(container.querySelector("openclaw-workspace-icon")).toBe(element);
      expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
        "blob:recovered-workspace-icon",
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("does not refetch a missing project icon when the header rerenders", async () => {
    const fetchSpy = mockWorkspaceIconRoute().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);
    const workspaceIcon = {
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["token"],
      authReady: true,
    };
    const mounted = mountHeader({ workspaceIcon });
    const element = mounted.container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete?: Promise<unknown> })
      | null;

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await element?.updateComplete;
    render(
      html`${renderChatPaneHeader({ ...mounted.props, title: "Updated title", workspaceIcon })}`,
      mounted.container,
    );
    await element?.updateComplete;
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    render(
      html`${renderChatPaneHeader({
        ...mounted.props,
        workspaceIcon: { ...workspaceIcon, authTokens: ["new-token"] },
      })}`,
      mounted.container,
    );
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
  });

  it("retries the next credential when a stale token is rejected", async () => {
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = mockWorkspaceIconRoute()
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: async () => png,
      } as unknown as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:workspace-icon");

    await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aone",
      authTokens: ["stale-token", "session-password"],
      authReady: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer session-password" },
    });
    vi.restoreAllMocks();
  });
});
