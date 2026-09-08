/* @vitest-environment jsdom */
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { MultiSelect, type MultiSelectOption } from "./multi-select.ts";

const MULTI_SELECT_TEST_TAG = `test-openclaw-multi-select-${crypto.randomUUID()}`;

type MultiSelectElement = HTMLElement & {
  options: readonly MultiSelectOption[];
  value: readonly string[];
  exclude: readonly string[];
  placeholder: string;
  allowCustom: boolean;
  disabled: boolean;
  onChange: (value: string[]) => void;
  onOpen: () => void;
  updateComplete: Promise<boolean>;
};

const primary = "openai/gpt-5.4";
const sonnet = "anthropic/claude-sonnet-4-6";
const opus = "anthropic/claude-opus-4-7";
const gemini = "google/gemini-3-pro";
const options: MultiSelectOption[] = [
  { value: primary, label: "GPT-5.4", provider: "openai" },
  { value: sonnet, label: "Claude Sonnet 4.6", provider: "anthropic" },
  { value: opus, label: "Claude Opus 4.7", provider: "anthropic" },
  { value: gemini, label: "Gemini 3 Pro", provider: "google" },
];

beforeAll(() => {
  // Web Awesome's popup observes its anchor; jsdom has no ResizeObserver.
  if (!("ResizeObserver" in globalThis)) {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  customElements.define(MULTI_SELECT_TEST_TAG, class extends MultiSelect {});
});

afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function createMultiSelect(
  overrides: Partial<Omit<MultiSelectElement, keyof HTMLElement>> = {},
): Promise<MultiSelectElement> {
  const element = document.createElement(MULTI_SELECT_TEST_TAG) as MultiSelectElement;
  element.options = options;
  element.value = [sonnet];
  element.exclude = [primary];
  element.placeholder = "Add fallback…";
  element.allowCustom = true;
  element.onChange = vi.fn();
  element.onOpen = vi.fn();
  Object.assign(element, overrides);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function input(element: MultiSelectElement): HTMLInputElement {
  const found = element.querySelector<HTMLInputElement>("input.multi-select__input");
  if (!found) {
    throw new Error("multi-select input missing");
  }
  return found;
}

function rowValues(element: MultiSelectElement): Array<string | null> {
  return Array.from(element.querySelectorAll(".multi-select__option")).map((row) =>
    row.getAttribute("data-value"),
  );
}

function chipValues(element: MultiSelectElement): Array<string | null> {
  return Array.from(element.querySelectorAll(".multi-select__chip")).map((chip) =>
    chip.getAttribute("data-value"),
  );
}

function isOpen(element: MultiSelectElement): boolean {
  return input(element).getAttribute("aria-expanded") === "true";
}

async function typeText(element: MultiSelectElement, text: string) {
  const field = input(element);
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await element.updateComplete;
}

async function pressKey(element: MultiSelectElement, key: string) {
  input(element).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
  await element.updateComplete;
}

async function clickField(element: MultiSelectElement) {
  element
    .querySelector(".multi-select")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await element.updateComplete;
}

it("renders chips with option labels and lists only unchosen, unexcluded options once opened", async () => {
  const element = await createMultiSelect();

  expect(chipValues(element)).toEqual([sonnet]);
  const chip = element.querySelector(".multi-select__chip");
  expect(chip?.querySelector(".multi-select__chip-label")?.textContent?.trim()).toBe(
    "Claude Sonnet 4.6",
  );
  expect(chip?.querySelector(".multi-select__chip-icon")).not.toBeNull();
  expect(isOpen(element)).toBe(false);

  await clickField(element);

  expect(isOpen(element)).toBe(true);
  expect(element.onOpen).toHaveBeenCalledTimes(1);
  expect(rowValues(element)).toEqual([opus, gemini]);
});

it("filters rows by typed text and appends the highlighted row on Enter", async () => {
  const element = await createMultiSelect();

  await typeText(element, "gem");
  // Matches lead and stay highlighted; the custom entry trails them so Enter
  // never adds a partial search term by accident.
  expect(rowValues(element)).toEqual([gemini, "gem"]);
  expect(element.querySelector(".multi-select__option")?.getAttribute("aria-selected")).toBe(
    "true",
  );

  await pressKey(element, "Enter");

  expect(element.onChange).toHaveBeenCalledWith([sonnet, gemini]);
  expect(input(element).value).toBe("");
});

it("offers typed text as a custom row and commits it with Enter or comma", async () => {
  const element = await createMultiSelect();
  const custom = "openrouter/mistral/mistral-large";

  await typeText(element, custom);
  expect(rowValues(element)).toEqual([custom]);
  const row = element.querySelector(".multi-select__option");
  expect(row?.hasAttribute("data-custom")).toBe(true);
  expect(row?.textContent).toContain(`Add “${custom}”`);

  await pressKey(element, "Enter");
  expect(element.onChange).toHaveBeenLastCalledWith([sonnet, custom]);

  await typeText(element, "vendor/model");
  await pressKey(element, ",");
  expect(element.onChange).toHaveBeenLastCalledWith([sonnet, "vendor/model"]);
});

it("does not offer custom rows for values already chosen or excluded", async () => {
  const element = await createMultiSelect();

  await typeText(element, primary);

  expect(rowValues(element)).toEqual([]);
  expect(element.querySelector(".multi-select__empty")?.textContent?.trim()).toBe("No matches");
  await pressKey(element, "Enter");
  expect(element.onChange).not.toHaveBeenCalled();
});

it("removes chips with Backspace on empty text and with the chip button", async () => {
  const element = await createMultiSelect({ value: [sonnet, gemini] });

  await pressKey(element, "Backspace");
  expect(element.onChange).toHaveBeenLastCalledWith([sonnet]);

  element.querySelector<HTMLButtonElement>(".multi-select__chip .chip-remove")?.click();
  expect(element.onChange).toHaveBeenLastCalledWith([gemini]);
});

it("moves the highlight with arrow keys and closes on Escape", async () => {
  const element = await createMultiSelect();

  await pressKey(element, "Enter");
  expect(element.onChange).not.toHaveBeenCalled();
  await pressKey(element, "ArrowDown");
  expect(isOpen(element)).toBe(true);
  await pressKey(element, "ArrowDown");
  const highlighted = () =>
    Array.from(element.querySelectorAll(".multi-select__option")).findIndex(
      (row) => row.getAttribute("aria-selected") === "true",
    );
  expect(highlighted()).toBe(1);
  await pressKey(element, "ArrowUp");
  expect(highlighted()).toBe(0);

  await typeText(element, "op");
  await pressKey(element, "Escape");

  expect(isOpen(element)).toBe(false);
  expect(input(element).value).toBe("");
  await pressKey(element, "Enter");
  expect(element.onChange).not.toHaveBeenCalled();
});

it.each(["Tab", ",", "blur"])("commits typed references on %s", async (action) => {
  const outside = document.createElement("button");
  document.body.append(outside);
  for (const value of ["openrouter/pending", gemini]) {
    const element = await createMultiSelect();
    input(element).focus();
    await typeText(element, value);

    if (action !== "blur") {
      await pressKey(element, action);
    }
    if (action !== ",") {
      outside.focus();
      await element.updateComplete;
      expect(isOpen(element)).toBe(false);
    }

    expect(element.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, value]);
    expect(input(element).value).toBe("");
  }
});

it("appends pasted references in order without duplicating or adding excluded models", async () => {
  const element = await createMultiSelect();

  await typeText(element, `${gemini}, openrouter/pending, ${primary}, ${gemini.toUpperCase()}`);
  await pressKey(element, "Enter");

  expect(element.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, gemini, "openrouter/pending"]);
});

it("selects the visible highlight when a catalog refresh shortens the open list", async () => {
  const element = await createMultiSelect();

  await pressKey(element, "ArrowDown");
  await pressKey(element, "ArrowDown");
  element.options = options.filter((option) => option.value !== gemini);
  await element.updateComplete;
  const highlighted = element.querySelector('.multi-select__option[aria-selected="true"]');
  expect(highlighted?.getAttribute("data-value")).toBe(opus);
  await pressKey(element, "Enter");

  expect(element.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, opus]);
});

it("leaves composing input untouched until the operator confirms the completed value", async () => {
  const element = await createMultiSelect();
  await typeText(element, "local/模型");

  input(element).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await element.updateComplete;

  expect(element.onChange).not.toHaveBeenCalled();
  expect(input(element).value).toBe("local/模型");
  await pressKey(element, "Enter");
  expect(element.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, "local/模型"]);
});

it("stays inert while disabled", async () => {
  const element = await createMultiSelect({ disabled: true });

  expect(input(element).disabled).toBe(true);
  expect(element.querySelector<HTMLButtonElement>(".chip-remove")?.disabled).toBe(true);
  await clickField(element);

  expect(isOpen(element)).toBe(false);
  expect(element.onOpen).not.toHaveBeenCalled();
});
