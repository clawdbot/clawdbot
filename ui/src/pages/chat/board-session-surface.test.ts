/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardProviderForSession } from "../../lib/board/provider.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { renderBoardSessionSurface } from "./board-session-surface.ts";

const containers: HTMLElement[] = [];

installBrowserHistoryIsolation();

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

beforeEach(() => {
  window.history.replaceState({}, "", "/?mockBoard=1");
});

describe("board session shell", () => {
  it("preserves the board element while the dashboard panel activates and parks", () => {
    const container = createContainer();
    const provider = boardProviderForSession({ sessionKey: "agent:main:main" });
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
