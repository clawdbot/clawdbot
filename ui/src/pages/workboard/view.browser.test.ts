// Control UI tests cover workboard behavior.
import { nothing, render } from "lit";
import { describe, expect, it } from "vitest";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import { renderWorkboard } from "./view.ts";

type WorkboardRenderProps = Parameters<typeof renderWorkboard>[0];

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  render(renderWorkboard(props), container);
}

function dispatchKey(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

describe("workboard dialogs (browser)", () => {
  it("keeps modal focus inside Chromium inert background and restores the opener", async () => {
    const host = {};
    const state = getWorkboardState(host);
    state.loaded = true;
    state.cards = [];
    const container = document.createElement("div");
    document.body.append(container);
    const props: WorkboardRenderProps = {
      host,
      client: null,
      connected: true,
      pluginEnabled: true,
      agentsList: null,
      sessions: [],
      onOpenSession: () => undefined,
      onRequestUpdate: () => renderInto(container, props),
    };

    try {
      renderInto(container, props);
      const launcher = container.querySelector<HTMLButtonElement>(
        ".workboard-toolbar__actions .primary",
      );
      const backgroundSearch = container.querySelector<HTMLInputElement>(
        ".workboard-toolbar__filters input[type='search']",
      );
      expect(launcher).toBeInstanceOf(HTMLButtonElement);
      expect(backgroundSearch).toBeInstanceOf(HTMLInputElement);

      launcher?.focus();
      launcher?.click();
      await nextFrame();

      const modal = container.querySelector("openclaw-modal-dialog");
      const dialog = modal?.shadowRoot
        ?.querySelector("wa-dialog")
        ?.shadowRoot?.querySelector("dialog");
      const titleInput = container.querySelector<HTMLInputElement>(".workboard-draft__title");
      const main = container.querySelector<HTMLElement>(".workboard-main");
      expect(dialog?.open).toBe(true);
      expect(dialog?.getAttribute("aria-label")).toBe("New card");
      expect(dialog?.getAttribute("aria-description")).toContain("Queue work");
      await expect.poll(() => document.activeElement).toBe(titleInput);

      backgroundSearch?.focus();
      if (navigator.userAgent.includes("Chrome") || navigator.webdriver) {
        expect(document.activeElement).toBe(titleInput);
      } else {
        expect(document.activeElement).toBe(backgroundSearch);
        titleInput?.focus();
      }

      dispatchKey(titleInput!, "Escape");
      await nextFrame();
      await nextFrame();

      expect(container.querySelector(".workboard-draft")).toBeNull();
      expect(main).not.toBeNull();
      expect(document.activeElement).toBe(launcher);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });
});
