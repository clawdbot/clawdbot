// Control UI tests cover workboard behavior.
import { nothing, render } from "lit";
import { describe, expect, it } from "vitest";
import { getWorkboardState } from "../controllers/workboard.ts";
import { renderWorkboard } from "./workboard.ts";

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

      const modal = container.querySelector<HTMLElement>(".workboard-draft");
      const titleInput = container.querySelector<HTMLInputElement>(".workboard-draft__title");
      const main = container.querySelector<HTMLElement>(".workboard-main");
      expect(modal?.getAttribute("role")).toBe("dialog");
      expect(modal?.getAttribute("aria-modal")).toBe("true");
      expect(modal?.getAttribute("aria-labelledby")).toBe("workboard-card-modal-title");
      expect(modal?.getAttribute("aria-describedby")).toBe("workboard-card-modal-description");
      expect(document.activeElement).toBe(titleInput);
      expect(main?.hasAttribute("inert")).toBe(true);
      expect(main?.getAttribute("aria-hidden")).toBe("true");

      backgroundSearch?.focus();
      if (navigator.userAgent.includes("Chrome") || navigator.webdriver) {
        expect(document.activeElement).toBe(titleInput);
      } else {
        expect(document.activeElement).toBe(backgroundSearch);
        titleInput?.focus();
      }

      const close = modal!.querySelector<HTMLButtonElement>("button[aria-label='Cancel']");
      const cancel = [...modal!.querySelectorAll<HTMLButtonElement>("button")].at(-1);
      cancel?.focus();
      const tab = dispatchKey(cancel!, "Tab");
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(close);

      dispatchKey(titleInput!, "Escape");
      await nextFrame();
      await nextFrame();

      expect(container.querySelector(".workboard-draft")).toBeNull();
      expect(main?.hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(launcher);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });
});
