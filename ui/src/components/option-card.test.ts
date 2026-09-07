/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./option-card.ts";

describe("option card", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("accents and focuses the recommended choice, then emits its value", async () => {
    const onSelect = vi.fn();
    const selected = vi.fn();
    container.addEventListener("option-select", selected);
    render(
      html`<openclaw-option-card
        .props=${{
          header: "Access",
          question: "How should OpenClaw help?",
          options: [
            { value: "guarded", label: "Ask first" },
            {
              value: "full",
              label: "Full access",
              description: "Use announced defaults",
              recommended: true,
            },
          ],
          onSelect,
        }}
      ></openclaw-option-card>`,
      container,
    );
    const card = container.querySelector("openclaw-option-card")!;
    await card.updateComplete;
    const recommended = container.querySelector<HTMLButtonElement>(
      ".option-card__choice--recommended",
    )!;

    expect(recommended.getAttribute("aria-checked")).toBe("true");
    expect(recommended.textContent).toContain("Recommended");
    expect(document.activeElement).toBe(recommended);
    recommended.click();

    expect(onSelect).toHaveBeenCalledWith("full");
    expect(selected).toHaveBeenCalledOnce();
    const selectEvent = selected.mock.calls[0]![0] as CustomEvent;
    expect(selectEvent.detail).toEqual({ value: "full" });
  });

  it("always renders a skip affordance and emits dismissal", async () => {
    const onSkip = vi.fn();
    const skipped = vi.fn();
    container.addEventListener("option-skip", skipped);
    render(
      html`<openclaw-option-card
        .props=${{
          question: "Choose one",
          options: [
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
          ],
          onSkip,
        }}
      ></openclaw-option-card>`,
      container,
    );
    await container.querySelector("openclaw-option-card")!.updateComplete;
    container.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    expect(onSkip).toHaveBeenCalledOnce();
    expect(skipped).toHaveBeenCalledOnce();
  });
});
