/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { createMockBoardProvider } from "../../test-helpers/board-provider.ts";
import { renderBoardSessionSurface } from "./board-session-surface.ts";

const containers: HTMLElement[] = [];

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("board session shell", () => {
  it("preserves the board element while the dashboard panel activates and parks", () => {
    const container = createContainer();
    const provider = createMockBoardProvider("agent:main:main");
    const props = {
      active: true,
      session: { sessionKey: "agent:main:main" },
      snapshot: provider.snapshot$.value,
      activeTabId: "main",
      canMutate: true,
      canGrant: true,
      callbacks: {
        applyOps: (ops: Parameters<typeof provider.applyOps>[0]) => provider.applyOps(ops),
        grant: (...args: Parameters<typeof provider.grant>) => provider.grant(...args),
        selectTab: () => {},
      },
      widgetFrameUrl: (name: string, revision: number) => provider.widgetFrameUrl(name, revision),
    };

    render(renderBoardSessionSurface(props), container);
    const board = container.querySelector("openclaw-board-view");

    render(renderBoardSessionSurface({ ...props, active: false }), container);
    const hiddenSurface = container.querySelector<HTMLElement>(".board-session-surface");
    expect(hiddenSurface?.hidden).toBe(true);
    expect(hiddenSurface?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(board?.active).toBe(false);

    render(renderBoardSessionSurface(props), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector<HTMLElement>(".board-session-surface")?.hidden).toBe(false);
    expect(board?.active).toBe(true);
  });
});
