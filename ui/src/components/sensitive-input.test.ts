/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSensitiveInput } from "./sensitive-input.ts";

describe("renderSensitiveInput", () => {
  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });

  it("conceals the value and keeps the Carapace mask in sync", () => {
    const container = document.createElement("div");
    const onInput = vi.fn();
    document.body.append(container);
    render(
      renderSensitiveInput({
        id: "secret",
        name: "secret",
        value: "secret",
        revealed: false,
        revealLabel: "Show API key",
        hideLabel: "Hide API key",
        onInput,
        onToggle: vi.fn(),
      }),
      container,
    );

    const input = container.querySelector<HTMLInputElement>("[data-sensitive-value]");
    const mask = container.querySelector<HTMLElement>("[data-sensitive-mask]");
    const maskText = container.querySelector<HTMLElement>("[data-sensitive-mask-text]");
    const toggle = container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(input?.type).toBe("password");
    expect(mask?.hidden).toBe(false);
    expect(maskText?.textContent).toBe("******");
    expect(toggle?.dataset.sensitiveIcon).toBe("eye");
    expect(toggle?.getAttribute("aria-label")).toBe("Show API key");
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");

    if (input) {
      input.value = "longer-key";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.scrollLeft = 12;
      input.dispatchEvent(new Event("scroll"));
    }
    expect(onInput).toHaveBeenCalledWith("longer-key");
    expect(maskText?.textContent).toBe("**********");
    expect(maskText?.style.transform).toBe("translateX(-12px)");

    if (input) {
      input.value = "👨‍👩‍👧‍👦x";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(maskText?.textContent).toBe("**");
  });

  it("reveals the value and presents the hide action", () => {
    const container = document.createElement("div");
    const onToggle = vi.fn();
    document.body.append(container);
    render(
      renderSensitiveInput({
        id: "secret",
        value: "secret",
        revealed: true,
        revealLabel: "Show API key",
        hideLabel: "Hide API key",
        disabled: false,
        onInput: vi.fn(),
        onToggle,
      }),
      container,
    );

    const input = container.querySelector<HTMLInputElement>("[data-sensitive-value]");
    const mask = container.querySelector<HTMLElement>(".oc-sensitive-mask");
    const toggle = container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle");
    expect(input?.type).toBe("text");
    expect(input?.value).toBe("secret");
    expect(mask?.hidden).toBe(true);
    expect(toggle?.dataset.sensitiveIcon).toBe("eye-off");
    expect(toggle?.getAttribute("aria-label")).toBe("Hide API key");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");

    toggle?.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
