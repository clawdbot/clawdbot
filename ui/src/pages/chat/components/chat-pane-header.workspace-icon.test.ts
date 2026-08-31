/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  mockWorkspaceIconFetch,
  mountChatPaneHeader,
  type ChatPaneHeaderProps,
} from "./chat-pane-header.test-support.ts";
import { renderChatPaneHeader } from "./chat-pane-header.ts";

const containers: HTMLElement[] = [];

afterEach(async () => {
  containers.splice(0).forEach((container) => container.remove());
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountHeader(patch: Partial<ChatPaneHeaderProps>) {
  return mountChatPaneHeader(containers, patch);
}

describe("chat pane workspace chip icon", () => {
  async function mountChip(workspaceIcon: ChatPaneHeaderProps["workspaceIcon"]) {
    const { container } = mountHeader({ workspaceIcon });
    const element = container.querySelector("openclaw-workspace-icon") as
      | (HTMLElement & { updateComplete: Promise<unknown>; requestUpdate(): void })
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
    const fetchSpy = mockWorkspaceIconFetch();
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
    const fetchSpy = mockWorkspaceIconFetch().mockRejectedValue(
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

  it("releases a queued icon render on disconnect and recovers on reconnect", async () => {
    vi.useFakeTimers();
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Adisconnected",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    element?.requestUpdate();
    container.remove();
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/workspace-icon/agent%3Amain%3Adisconnected",
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    fetchSpy.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["icon"], { type: "image/png" }),
    } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:reconnected-workspace-icon");
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await element?.updateComplete;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:reconnected-workspace-icon",
    );
  });

  it("recovers when a pending 503 settles between disconnect and immediate reconnect", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<Response>();
    const routeUrl = "/__openclaw__/workspace-icon/agent%3Amain%3Aimmediate-reconnect";
    const fetchSpy = mockWorkspaceIconFetch()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        ok: true,
        blob: async () => new Blob(["icon"], { type: "image/png" }),
      } as Response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:immediate-reconnect");
    const { container, element } = await mountChip({
      routeUrl,
      authTokens: ["token"],
      authReady: true,
    });
    container.remove();
    pending.resolve({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    await pending.promise;

    // Reattach in this task, before the deferred DOM-handoff release can delete the entry.
    document.body.append(container);
    await element?.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([routeUrl, routeUrl]);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:immediate-reconnect",
    );
  });

  it("recovers the workspace icon after a transient route timeout", async () => {
    vi.useFakeTimers();
    // A previous header can disconnect with a Lit render still queued. Its
    // released retry must not consume the replacement header's response.
    mockWorkspaceIconFetch().mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
    } as Response);
    const previous = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Aprevious",
      authTokens: ["token"],
      authReady: true,
    });
    previous.element?.requestUpdate();
    previous.container.remove();
    await previous.element?.updateComplete;
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fetchSpy = mockWorkspaceIconFetch()
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
    const { container, element } = await mountChip({
      routeUrl: "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      authTokens: ["token"],
      authReady: true,
    });
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(container.querySelector(".workspace-icon")).toBeNull();
    expect(container.querySelector(".chat-pane__workspace-chip svg")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await element?.updateComplete;

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
      "/__openclaw__/workspace-icon/agent%3Amain%3Arecovering",
    ]);
    expect(container.querySelector("openclaw-workspace-icon")).toBe(element);
    expect(container.querySelector<HTMLImageElement>(".workspace-icon")?.src).toBe(
      "blob:recovered-workspace-icon",
    );
  });

  it("does not refetch a missing project icon when the header rerenders", async () => {
    const fetchSpy = mockWorkspaceIconFetch().mockResolvedValue({
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
    const fetchSpy = mockWorkspaceIconFetch()
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
