import { expect, it, vi } from "vitest";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { mountWorkboardSessionAccessory } from "./session-accessory.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";

it("renders the linked card and releases lookup activity while hidden or disposed", async () => {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const sessionKey = "agent:main:workboard-card";
  const card = createWorkboardCard({
    title: "Ship dashboard stitch",
    status: "review",
    sessionKey,
    metadata: { automation: { boardId: "platform" } },
  });
  const request = vi.fn(async () => ({ cards: [card] }));
  fixture.host.request = request as typeof fixture.host.request;
  const container = document.createElement("div");
  const context = createViewContext(fixture.host, { sessionKey });
  const mounted = mountWorkboardSessionAccessory(container, context);
  try {
    await vi.waitFor(() => expect(container.textContent).toContain(card.title));
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/workboard/platform");
    expect(link.textContent).toContain("Review");
    link.click();
    expect(fixture.host.navigation.openPage).toHaveBeenCalledWith({
      id: "workboard",
      path: ["platform"],
    });
    mounted?.update?.({ ...context, presented: false, props: { sessionKey: "agent:main:next" } });
    expect(container.querySelector("a")).toBeNull();
    expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
    const count = request.mock.calls.length;
    fixture.emit("plugin.workboard.changed", {});
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(count);
    mounted?.update?.({ ...context, props: { sessionKey: "agent:main:next" } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count + 1));
    expect(container.textContent).not.toContain(card.title);
  } finally {
    mounted?.dispose?.();
  }
  expect(fixture.events.get("plugin.workboard.changed")?.size).toBe(0);
  expect(fixture.listeners.size).toBe(0);
});
