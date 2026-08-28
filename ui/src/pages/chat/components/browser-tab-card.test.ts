/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { RouteId } from "../../../app-route-paths.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { latestBrowserTabCards } from "../../../lib/chat/browser-tab-preview.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderActivityGroup } from "./chat-message-group.ts";
import { renderToolPreview } from "./widget-card.ts";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function gatewayContext(methods = ["browser.request"], scopes = ["operator.admin"]) {
  const request = vi.fn().mockResolvedValue({ path: "/tmp/tab.png" });
  const listeners = new Set<() => void>();
  const snapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected",
    hello: { features: { methods }, auth: { role: "operator", scopes } },
  } as ApplicationGatewaySnapshot;
  const context = {
    resourceBasePath: "/gateway",
    gateway: {
      snapshot,
      connection: { token: "", password: "" },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  } as unknown as ApplicationContext<RouteId>;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      ({
        ok: true,
        blob: async () => new Blob(["thumbnail"], { type: "image/png" }),
      }) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    context,
    request,
    fetchMock,
    snapshot,
    notify: () => listeners.forEach((listener) => listener()),
    listeners,
  };
}

function container() {
  const host = document.createElement("div");
  hosts.push(host);
  document.body.append(host);
  return host;
}

async function card(context: ApplicationContext<RouteId>, latest = true) {
  const host = container();
  render(
    renderToolPreview(
      { kind: "browser-tab", targetId: "tab-1", url: "https://example.com/page" },
      "chat_tool",
      {
        browserTabRevision: "one",
        browserTabLatest: latest,
      },
    ),
    host,
  );
  const element = host.querySelector("openclaw-browser-tab-card")!;
  element.context = context;
  await element.updateComplete;
  return element;
}

describe("browser tab card", () => {
  it.each([
    { methods: [], scopes: ["operator.admin"] },
    { methods: ["browser.request"], scopes: ["operator.read"] },
  ])("keeps a chip without advertised browser access (%j)", async ({ methods, scopes }) => {
    const gateway = gatewayContext(methods, scopes);
    const element = await card(gateway.context);
    expect(element.shadowRoot?.querySelector(".title")?.textContent).toBe("example.com");
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
    expect(gateway.request).not.toHaveBeenCalled();
    expect(gateway.fetchMock).not.toHaveBeenCalled();
    const toggle = vi.fn<(event: Event) => void>();
    element.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, toggle);
    element.shadowRoot?.querySelector("button")?.click();
    expect(toggle).toHaveBeenCalledOnce();
    const event = toggle.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect(event instanceof CustomEvent ? event.detail : undefined).toEqual({
      open: true,
      targetId: "tab-1",
    });
  });

  it("shares one screenshot between latest cards and leaves older cards as chips", async () => {
    const gateway = gatewayContext();
    const older = await card(gateway.context, false);
    const first = await card(gateway.context);
    const duplicate = await card(gateway.context);
    await vi.waitFor(() => expect(duplicate.shadowRoot?.querySelector("img")).not.toBeNull());
    expect(first.shadowRoot?.querySelector("img")).not.toBeNull();
    expect(older.shadowRoot?.querySelector("img")).toBeNull();
    expect(gateway.request).toHaveBeenCalledOnce();
    expect(gateway.fetchMock).toHaveBeenCalledOnce();
    first.remove();
    duplicate.remove();
    older.remove();
    expect(gateway.listeners.size).toBe(0);
    const remounted = await card(gateway.context);
    await vi.waitFor(() => expect(remounted.shadowRoot?.querySelector("img")).not.toBeNull());
    expect(gateway.request).toHaveBeenCalledOnce();
  });

  it("renders cards outside the activity disclosure and refreshes only the newest completion", async () => {
    const gateway = gatewayContext();
    const message = (id: string) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "browser",
      content: "ok",
      details: { browserTab: { targetId: "tab-1", title: id } },
    });
    const host = container();
    const messages = [message("old"), message("new")];
    const draw = async (expanded: boolean) => {
      const group: MessageGroup = {
        kind: "group",
        key: "browser-results",
        role: "tool",
        isStreaming: false,
        timestamp: 1,
        messages: messages.map((result) => ({ key: result.toolCallId, message: result })),
      };
      render(
        renderActivityGroup([group], {
          showReasoning: false,
          latestBrowserTabs: latestBrowserTabCards(messages, []),
          isToolMessageExpanded: () => expanded,
        }),
        host,
      );
      const elements = [...host.querySelectorAll("openclaw-browser-tab-card")];
      for (const element of elements) {
        element.context = gateway.context;
        await element.updateComplete;
      }
      return elements;
    };
    // Same-tab results collapse to one card showing the newest completion.
    const initial = await draw(false);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.shadowRoot?.querySelector(".title")?.textContent).toBe("new");
    expect(initial.every((element) => !element.closest(".chat-activity-group__body"))).toBe(true);
    await vi.waitFor(() => expect(initial[0]?.shadowRoot?.querySelector("img")).not.toBeNull());
    expect(await draw(true)).toHaveLength(1);
    expect(gateway.request).toHaveBeenCalledOnce();
    messages.push(message("newest"));
    const next = await draw(false);
    expect(next).toHaveLength(1);
    expect(next[0]?.shadowRoot?.querySelector(".title")?.textContent).toBe("newest");
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(next[0]?.shadowRoot?.querySelector("img")).not.toBeNull());
  });

  it("keeps one card per distinct tab", async () => {
    const gateway = gatewayContext();
    const message = (id: string, targetId: string) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "browser",
      content: "ok",
      details: { browserTab: { targetId, title: id } },
    });
    const messages = [message("old", "tab-1"), message("new", "tab-1"), message("other", "tab-2")];
    const host = container();
    const group: MessageGroup = {
      kind: "group",
      key: "browser-results",
      role: "tool",
      isStreaming: false,
      timestamp: 1,
      messages: messages.map((result) => ({ key: result.toolCallId, message: result })),
    };
    render(
      renderActivityGroup([group], {
        showReasoning: false,
        latestBrowserTabs: latestBrowserTabCards(messages, []),
        isToolMessageExpanded: () => false,
      }),
      host,
    );
    const elements = [...host.querySelectorAll("openclaw-browser-tab-card")];
    for (const element of elements) {
      element.context = gateway.context;
      await element.updateComplete;
    }
    expect(
      elements.map((element) => element.shadowRoot?.querySelector(".title")?.textContent),
    ).toEqual(["new", "other"]);
  });

  it("discards a pending image when browser access disappears", async () => {
    const gateway = gatewayContext();
    const pending = createDeferred<{ path: string }>();
    gateway.request.mockReturnValueOnce(pending.promise);
    const element = await card(gateway.context);
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
    gateway.snapshot.phase = "offline";
    gateway.notify();
    await element.updateComplete;
    pending.resolve({ path: "/tmp/tab.png" });
    await vi.waitFor(() => expect(gateway.fetchMock).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.shadowRoot?.querySelector("img")).toBeNull();
  });
});
