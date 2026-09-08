import type WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderPicker,
  type PickerParams,
  type PickerOption,
  type SelectPicker,
} from "./select-picker.ts";

const options: PickerOption[] = [
  { value: "fixture/anchor", label: "Anchor", description: "Fixture provider" },
  { value: "fixture/aurora-large", label: "Aurora Large" },
  { value: "other/aurora-small", label: "Aurora Small", disabled: true },
  ...Array.from({ length: 6 }, (_, index) => ({
    value: `fixture/model-${index}`,
    label: `Model ${index}`,
  })),
];

afterEach(() => document.body.replaceChildren());

async function mount(overrides: Partial<PickerParams<PickerOption>> = {}) {
  const params: PickerParams<PickerOption> = {
    label: "Model",
    value: "fixture/anchor",
    options,
    searchable: true,
    onChange: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const update = async (patch: Partial<PickerParams<PickerOption>>) => {
    Object.assign(params, patch);
    render(html`${renderPicker({ ...params })}<button id="next">Next</button>`, container);
    await container.querySelector<SelectPicker>("openclaw-select-picker")!.updateComplete;
  };
  await update({});
  const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
  const trigger = picker.querySelector<HTMLButtonElement>("button")!;
  const open = async () => {
    trigger.click();
    await picker.updateComplete;
  };
  const search = async (value: string) => {
    const input = picker.querySelector<HTMLInputElement>("input")!;
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await picker.updateComplete;
    return input;
  };
  const rows = () => [...picker.querySelectorAll<HTMLElement>('[role="option"]')];
  const key = async (name: string, input: KeyboardEventInit = {}) => {
    const target = picker.querySelector<HTMLElement>("[data-picker-focus]") ?? trigger;
    const event = new KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...input,
    });
    target.dispatchEvent(event);
    await picker.updateComplete;
    return event;
  };
  return { params, picker, trigger, open, search, rows, key, update, container };
}

describe("renderPicker", () => {
  it("anchors its popup to the mounted trigger before the first open", async () => {
    const p = await mount();
    const popup = p.picker.querySelector<WaPopup>("wa-popup");
    expect(popup?.anchor).toBe(p.trigger);
  });

  it("leaves closed-trigger Escape to the page after dismissing the menu without a write", async () => {
    const p = await mount();
    const pageKey = vi.fn();
    p.container.addEventListener("keydown", pageKey);
    p.trigger.focus();
    p.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pageKey).toHaveBeenCalledOnce();
    pageKey.mockClear();
    await p.open();
    await p.key("Escape");
    expect(pageKey).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(p.trigger);
    p.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pageKey).toHaveBeenCalledOnce();
    expect(p.params.onChange).not.toHaveBeenCalled();
  });

  it("names the field and current selection when the closed trigger receives focus", async () => {
    const p = await mount();
    p.trigger.focus();
    expect(p.trigger.getAttribute("aria-label")).toBe("Model: Anchor");
    await p.update({ value: "fixture/aurora-large" });
    expect(p.trigger.getAttribute("aria-label")).toBe("Model: Aurora Large");
    expect(p.params.onChange).not.toHaveBeenCalled();
  });

  it("retains the current short-menu choice when typeahead has no match", async () => {
    const p = await mount({
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      value: "beta",
    });
    await p.open();
    await p.key("z");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("beta");
  });

  it("opens a compact menu with a printable key without committing it", async () => {
    const p = await mount({
      options: [
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
      ],
      value: "beta",
    });
    await p.key("a");
    expect(p.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("uses spaces and backspace for compact-menu typeahead without an early commit", async () => {
    const p = await mount({
      options: [
        { value: "cat", label: "Big Cat" },
        { value: "dog", label: "Big Dog" },
      ],
      value: "cat",
    });
    await p.open();
    for (const key of ["b", "i", "g", " ", "c", "Backspace", "d"]) {
      await p.key(key);
    }
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("dog");
  });

  it("filters label and exact reference substrings without changing the selected value", async () => {
    const p = await mount();
    await p.open();
    await p.search("AURORA");
    expect(p.rows().map((row) => row.dataset.value)).toEqual([
      "fixture/aurora-large",
      "other/aurora-small",
    ]);
    await p.search("TURE/AURORA-L");
    expect(p.rows().map((row) => row.dataset.value)).toEqual(["fixture/aurora-large"]);
    expect(p.trigger.textContent).toContain("Anchor");
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.search("");
    expect(p.rows()).toHaveLength(9);
    expect(p.rows()[0]?.textContent).toContain("Fixture provider");
    await p.key("Escape");
    expect(document.activeElement).toBe(p.trigger);
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.open();
    expect(p.picker.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(p.rows()).toHaveLength(9);
  });

  it("commits an enabled visible choice once and skips disabled keyboard rows", async () => {
    const p = await mount();
    await p.open();
    await p.search("aurora");
    await p.key("ArrowDown");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("fixture/aurora-large");
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not select disabled rows or a row removed by a catalog refresh", async () => {
    const p = await mount();
    await p.open();
    const [, removed, disabled] = p.rows();
    if (!removed || !disabled) {
      throw new Error("Expected enabled and disabled model rows");
    }
    disabled.click();
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.search("aurora");
    await p.update({
      options: options.filter((option) => option.value !== "fixture/aurora-large"),
    });
    expect(p.picker.querySelector<HTMLInputElement>("input")!.value).toBe("aurora");
    removed.click();
    await p.key("Enter");
    expect(p.params.onChange).not.toHaveBeenCalled();
    await p.key("Escape");
    await p.open();
    expect(p.picker.querySelector("input")).toBeNull();
    expect(p.rows()).toHaveLength(8);
  });

  it("announces no matches and leaves composition and text editing keys alone", async () => {
    const p = await mount();
    await p.open();
    await p.search("not-present");
    expect(p.rows()).toHaveLength(0);
    expect(p.picker.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(false);
    expect(p.picker.querySelector('[role="status"]')!.textContent?.trim()).toBe("No matches");
    expect((await p.key(" ")).defaultPrevented).toBe(false);
    expect((await p.key("Home")).defaultPrevented).toBe(false);
    expect((await p.key("Enter", { isComposing: true })).defaultPrevented).toBe(false);
    expect(p.params.onChange).not.toHaveBeenCalled();
    const shortcut = vi.fn();
    p.container.addEventListener("keydown", shortcut);
    await p.key("x");
    expect(shortcut).not.toHaveBeenCalled();
  });

  it("keeps short menus compact, supports typeahead, and retains empty/unknown values", async () => {
    const p = await mount({
      value: "retired/model",
      options: [
        { value: "", label: "Automatic" },
        { value: "new/model", label: "New model" },
      ],
    });
    await p.key("ArrowDown");
    expect(p.picker.querySelector("input")).toBeNull();
    expect(p.trigger.textContent).toContain("retired/model");
    await p.key("a");
    await p.key("Enter");
    expect(p.params.onChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("does not write on outside dismissal, disables an open picker, and closes on disconnect", async () => {
    const p = await mount();
    await p.open();
    await p.search("aurora");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await p.picker.updateComplete;
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
    await p.open();
    await p.update({ disabled: true });
    expect(p.trigger.disabled).toBe(true);
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(p.params.onChange).not.toHaveBeenCalled();
    p.picker.remove();
    p.container.append(p.picker);
    await p.picker.updateComplete;
    expect(p.trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("retains label styles, open effects, and the capped readable-label floor", async () => {
    const onOpen = vi.fn();
    const p = await mount({
      options: [
        { value: "plain", label: "Plain" },
        { value: "styled", label: "Styled", labelStyle: "font-family: Georgia" },
      ],
      value: "plain",
      onOpen,
    });
    const labels = p.rows().map((row) => row.querySelector<HTMLElement>(".picker-select__label")!);
    expect(labels[0]?.hasAttribute("style")).toBe(false);
    expect(labels[1]?.style.fontFamily).toBe("Georgia");
    expect(onOpen).not.toHaveBeenCalled();
    await p.open();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(p.picker.getAttribute("style")).toContain("min-width:min(138px,100%)");
  });
});
