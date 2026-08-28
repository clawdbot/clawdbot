// Tests for inline scalar validation error accessibility (issue #127329).
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { analyzeConfigSchema, renderConfigForm } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("scalar validation error accessibility", () => {
  function renderScalarForm(schema: object, value: Record<string, unknown> | null = null) {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value,
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );
    return { container, onPatch };
  }

  function findError(input: HTMLInputElement): HTMLElement {
    return expectElement(
      input.closest(".cfg-scalar-input")?.querySelector<HTMLElement>(".cfg-field__error"),
      "inline error element",
    );
  }

  it("renders and clears inline error text for string pattern violations", () => {
    const { container } = renderScalarForm({
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          pattern: "[a-z]+",
          minLength: 2,
        },
      },
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
      "string input",
    );
    const error = findError(input);
    const errorId = error.getAttribute("id");
    expect(errorId).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toContain(errorId);
    expect(error.hidden).toBe(true);

    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(error.hidden).toBe(false);
    expect(error.textContent).not.toBe("");

    input.value = "ab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
  });

  it("renders inline error text for numeric range violations", () => {
    const { container } = renderScalarForm(
      {
        type: "object",
        required: ["settings"],
        properties: {
          settings: {
            type: "object",
            required: ["count"],
            properties: {
              count: {
                type: "integer",
                minimum: 2,
                maximum: 8,
              },
            },
          },
        },
      },
      { settings: { count: 4 } },
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Count']"),
      "number input",
    );
    const error = findError(input);
    expect(error.hidden).toBe(true);

    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(error.hidden).toBe(false);
    expect(error.textContent).not.toBe("");

    input.value = "4";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
  });

  it("clears stale error text when schema refresh resets the value", () => {
    const schema = {
      type: "object",
      required: ["settings"],
      properties: {
        settings: {
          type: "object",
          required: ["port"],
          properties: {
            port: {
              type: "integer",
              minimum: 1,
              maximum: 65535,
            },
          },
        },
      },
    };
    const { container, onPatch } = renderScalarForm(schema, { settings: { port: 443 } });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "number input",
    );
    const error = findError(input);

    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(error.hidden).toBe(false);

    render(
      renderConfigForm({
        schema: analyzeConfigSchema(schema).schema,
        uiHints: {},
        unsupportedPaths: analyzeConfigSchema(schema).unsupportedPaths,
        value: { settings: { port: 8080 } },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );
    const refreshedInput = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "refreshed number input",
    );
    const refreshedError = findError(refreshedInput);
    expect(refreshedError.hidden).toBe(true);
    expect(refreshedError.textContent).toBe("");
  });

  it("keeps scalar inputs as direct children of the cfg-scalar-input wrapper", () => {
    const { container } = renderScalarForm({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
      "string input",
    );
    // The input must be inside .cfg-scalar-input so desktop sizing rules
    // (.settings-row__control > .cfg-scalar-input > .settings-input) match.
    const wrapper = input.closest(".cfg-scalar-input");
    expect(wrapper instanceof HTMLElement).toBe(true);
    // The wrapper itself must be inside .settings-row__control.
    const control = wrapper?.parentElement;
    expect(control?.classList.contains("settings-row__control")).toBe(true);
  });

  it("keeps number inputs as direct children of the cfg-scalar-input wrapper", () => {
    const { container } = renderScalarForm(
      {
        type: "object",
        required: ["settings"],
        properties: {
          settings: {
            type: "object",
            required: ["count"],
            properties: { count: { type: "integer", minimum: 0, maximum: 10 } },
          },
        },
      },
      { settings: { count: 5 } },
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "number input",
    );
    const wrapper = input.closest(".cfg-scalar-input");
    expect(wrapper instanceof HTMLElement).toBe(true);
    const control = wrapper?.parentElement;
    expect(control?.classList.contains("settings-row__control")).toBe(true);
  });
});
