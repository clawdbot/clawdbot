// Control UI tests cover scalar identity and nullable enum behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderNumberInput, renderSelect, renderTextInput } from "./config-form.node.scalar.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form scalar integrity", () => {
  it("keeps repeated number input identity arguments aligned", () => {
    const container = document.createElement("div");
    const renderValue = (controlIdentity: number[]) => {
      render(
        renderNumberInput({
          schema: { type: "integer" },
          value: 2,
          path: ["values", 0],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          sourceIdentity: 2,
          controlIdentity,
          onPatch: vi.fn(),
        }),
        container,
      );
    };

    renderValue([2]);
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "repeated number input",
    );
    renderValue([2, 4]);
    expect(container.querySelector("input[type='number']")).toBe(input);
    expect(input.value).toBe("2");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("allows required nullable enums to select their null member", () => {
    const container = document.createElement("div");
    const nullablePatch = vi.fn();
    render(
      renderSelect({
        schema: {
          type: "string",
          nullable: true,
          enumIncludesNull: true,
        },
        value: "fixed",
        path: ["nullableMode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        isRequired: true,
        options: ["fixed", "other"],
        onPatch: nullablePatch,
      }),
      container,
    );
    const nullableSelect = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "required nullable enum",
    );
    const nullOption = expectElement(
      nullableSelect.querySelector<HTMLOptionElement>("option[value='__null__']"),
      "nullable enum null option",
    );
    expect(nullOption.disabled).toBe(false);
    expect(
      nullableSelect.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled,
    ).toBe(true);
    nullableSelect.value = "__null__";
    nullableSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(nullablePatch).toHaveBeenCalledWith(["nullableMode"], null);

    const requiredPatch = vi.fn();
    render(
      renderSelect({
        schema: { type: "string" },
        value: "fixed",
        path: ["requiredMode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        isRequired: true,
        options: ["fixed", "other"],
        onPatch: requiredPatch,
      }),
      container,
    );
    const requiredSelect = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "required non-null enum",
    );
    expect(
      requiredSelect.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled,
    ).toBe(true);
    requiredSelect.value = "__unset__";
    requiredSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(requiredSelect.value).toBe("0");
    expect(requiredPatch).not.toHaveBeenCalled();
  });

  it("keeps optional nullable enum unset distinct from explicit null", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const renderValue = (value: unknown) => {
      render(
        renderSelect({
          schema: {
            type: "string",
            nullable: true,
            enumIncludesNull: true,
          },
          value,
          path: ["mode"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          options: ["fixed", "other"],
          onPatch,
        }),
        container,
      );
    };

    renderValue(null);
    const select = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "optional nullable enum",
    );
    expect(select.value).toBe("__null__");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], undefined);

    renderValue("fixed");
    select.value = "__null__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], null);
  });

  it("shows inherited defaults without turning them into stored overrides", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();

    render(
      renderTextInput({
        schema: { type: "string", default: "balanced" },
        value: undefined,
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        onPatch,
        onRemove,
      }),
      container,
    );

    const textInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "defaulted text input",
    );
    expect(textInput.value).toBe("");
    expect(textInput.placeholder).toBe("Default: balanced");
    expect(container.textContent).toContain("Using default: balanced");
    expect(container.querySelector("button[aria-label='Reset to default']")).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    render(
      renderNumberInput({
        schema: { type: "integer", default: 3 },
        value: undefined,
        path: ["retries"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
        onRemove,
      }),
      container,
    );
    const numberInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "defaulted number input",
    );
    expect(numberInput.value).toBe("");
    expect(numberInput.placeholder).toBe("Default: 3");
    expect(container.textContent).toContain("Using default: 3");

    const arrowUp = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    numberInput.dispatchEvent(arrowUp);
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(onPatch).toHaveBeenLastCalledWith(["retries"], 4);
  });

  it("restores scalar and select defaults by removing optional overrides", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();

    render(
      renderNumberInput({
        schema: { type: "integer", default: 3 },
        value: 9,
        path: ["retries"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
        onRemove,
      }),
      container,
    );
    expect(container.textContent).toContain("Default: 3");
    expectElement(
      container.querySelector<HTMLButtonElement>("button[aria-label='Reset to default']"),
      "number reset",
    ).click();
    expect(onRemove).toHaveBeenCalledWith(["retries"]);
    expect(onPatch).not.toHaveBeenCalled();

    onRemove.mockClear();
    render(
      renderSelect({
        schema: { type: "string", default: "balanced" },
        value: "fast",
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
        onPatch,
        onRemove,
      }),
      container,
    );
    const select = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "default-aware select",
    );
    expect(container.textContent).toContain("Default: balanced");
    expect(select.options[0]?.textContent?.trim()).toBe("Default: balanced");
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("fast");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith(["mode"]);
    expect(onPatch).not.toHaveBeenCalled();

    render(
      renderSelect({
        schema: { type: "string", default: "balanced" },
        value: undefined,
        path: ["mode"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
        onPatch,
        onRemove,
      }),
      container,
    );
    expect(
      expectElement(
        container.querySelector<HTMLSelectElement>("select"),
        "inherited select",
      ).selectedOptions[0]?.textContent?.trim(),
    ).toBe("Default: balanced");
  });

  it("keeps restore disabled while a sensitive value is concealed", () => {
    const container = document.createElement("div");

    render(
      renderTextInput({
        schema: { type: "string", default: "inherited" },
        value: "stored-secret",
        path: ["secret"],
        hints: { secret: { sensitive: true } },
        unsupported: new Set(),
        disabled: false,
        inputType: "text",
        revealSensitive: false,
        onPatch: vi.fn(),
        onRemove: vi.fn(),
      }),
      container,
    );

    const reset = expectElement(
      container.querySelector<HTMLButtonElement>("button[aria-label='Reset to default']"),
      "concealed sensitive reset",
    );
    expect(reset.disabled).toBe(true);
    expect(container.textContent).not.toContain("inherited");
  });
});
