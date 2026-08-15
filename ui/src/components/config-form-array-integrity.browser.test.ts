// Control UI tests cover array draft recovery and repeated-item constraints.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { ConfigFormCollectionDraft } from "./config-form-collection-draft.ts";
import { renderArray } from "./config-form.node.collection.ts";
import type { JsonSchema } from "./config-form.shared.ts";
import { renderNode } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

type RenderArrayFixtureOptions = Omit<
  Parameters<typeof renderArray>[0],
  "disabled" | "hints" | "unsupported"
>;

function renderArrayFixture(container: HTMLElement, options: RenderArrayFixtureOptions): void {
  render(
    renderArray({ hints: {}, unsupported: new Set(), disabled: false, ...options }, renderNode),
    container,
  );
}

function findAddButton(container: Element): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === "Add",
  );
}

describe("config form array integrity", () => {
  it("applies safe whole-array composition candidates atomically", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: { type: "string" },
        allOf: [{ const: ["a", "b"] }],
      },
      value: undefined,
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    expectElement(findAddButton(container), "whole-array composition add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "b"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: { type: "string" },
        enum: [[], ["a", "b"]],
      },
      value: [],
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    expectElement(findAddButton(container), "valid constrained array extension").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "b"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: { type: "string", default: "item" },
        default: ["a", "b"],
      },
      value: [],
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    expectElement(findAddButton(container), "explicit empty array add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["item"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: { type: "string" },
        const: ["a", "b"],
      },
      value: [],
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    expectElement(findAddButton(container), "explicit invalid constrained array add").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "b"]);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: { type: "string" },
        const: [],
        maxItems: 0,
      },
      value: undefined,
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    const emptyConstAdd = expectElement(findAddButton(container), "empty const array add");
    expect(emptyConstAdd.disabled).toBe(false);
    emptyConstAdd.click();
    expect(onPatch).toHaveBeenCalledWith(["values"], []);

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: { type: "string" },
        maxItems: 0,
      },
      value: undefined,
      path: ["values"],
      isRequired: true,
      onPatch,
    });
    const requiredEmptyAdd = expectElement(
      findAddButton(container),
      "required empty-only array add",
    );
    expect(requiredEmptyAdd.disabled).toBe(false);
    requiredEmptyAdd.click();
    expect(onPatch).toHaveBeenCalledWith(["values"], []);
  });

  it("keeps large and unique array minimums incrementally editable", async () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const renderSchema = (schema: JsonSchema) => {
      renderArrayFixture(container, {
        schema,
        value: undefined,
        path: ["codes"],
        onPatch,
      });
    };

    renderSchema({
      type: "array",
      minItems: 101,
      items: { type: "string" },
    });
    const largeMinimumAdd = expectElement(findAddButton(container), "large minimum array add");
    expect(largeMinimumAdd.disabled).toBe(false);
    largeMinimumAdd.click();
    expect(onPatch).toHaveBeenCalledWith(["codes"], [""]);

    onPatch.mockClear();
    renderSchema({
      type: "array",
      minItems: 2,
      uniqueItems: true,
      items: { type: "string" },
    });
    const draftHost = expectElement(
      container.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "unique array draft",
    );
    await draftHost.updateComplete;
    expectElement(findAddButton(container), "unique array add").click();
    await draftHost.updateComplete;
    const draftValue = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "unique array draft value",
    );
    draftValue.value = "first";
    draftValue.dispatchEvent(new Event("input", { bubbles: true }));
    await draftHost.updateComplete;
    expectElement(findAddButton(draftHost), "unique array draft commit").click();
    expect(onPatch).toHaveBeenCalledWith(["codes"], ["first"]);

    // An autosave ack clones the form: identity churn with identical content
    // must not close an open draft mid-typing.
    expectElement(findAddButton(container), "reopened unique array add").click();
    await draftHost.updateComplete;
    const typedDraft = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "typed unique array draft",
    );
    typedDraft.value = "in-progress";
    typedDraft.dispatchEvent(new Event("input", { bubbles: true }));
    await draftHost.updateComplete;
    renderSchema({
      type: "array",
      minItems: 2,
      uniqueItems: true,
      items: { type: "string" },
    });
    await draftHost.updateComplete;
    const survivingDraft = draftHost.querySelector<HTMLInputElement>(
      "[data-collection-draft-value]",
    );
    expect(survivingDraft?.value).toBe("in-progress");

    onPatch.mockClear();
    renderArrayFixture(container, {
      schema: {
        type: "array",
        minItems: 2,
        uniqueItems: true,
        items: { type: "string" },
      },
      value: ["first"],
      path: ["codes"],
      onPatch,
    });
    const duplicateDraft = expectElement(
      container.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "duplicate array draft",
    );
    await duplicateDraft.updateComplete;
    expectElement(findAddButton(container), "duplicate array add").click();
    await duplicateDraft.updateComplete;
    const duplicateValue = expectElement(
      duplicateDraft.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "duplicate array draft value",
    );
    duplicateValue.value = "first";
    duplicateValue.dispatchEvent(new Event("input", { bubbles: true }));
    await duplicateDraft.updateComplete;
    expectElement(findAddButton(duplicateDraft), "duplicate array draft commit").click();
    await duplicateDraft.updateComplete;
    expect(duplicateValue.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    renderArrayFixture(container, {
      schema: {
        type: "array",
        minItems: 2,
        items: { type: "string" },
        allOf: [{ items: { type: "string", pattern: "^[0-9]+$" } }],
      },
      value: undefined,
      path: ["codes"],
      onPatch,
    });
    const composedDraft = expectElement(
      container.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "composed item draft",
    );
    await composedDraft.updateComplete;
    expectElement(findAddButton(container), "composed item add").click();
    await composedDraft.updateComplete;
    const composedValue = expectElement(
      composedDraft.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "composed item draft value",
    );
    composedValue.value = "abc";
    composedValue.dispatchEvent(new Event("input", { bubbles: true }));
    await composedDraft.updateComplete;
    const composedCommit = expectElement(
      findAddButton(composedDraft),
      "composed item draft commit",
    );
    composedCommit.click();
    await composedDraft.updateComplete;
    expect(composedValue.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    composedValue.value = "123";
    composedValue.dispatchEvent(new Event("input", { bubbles: true }));
    await composedDraft.updateComplete;
    composedCommit.click();
    expect(onPatch).toHaveBeenCalledWith(["codes"], ["123"]);
    container.remove();
  });

  it("rejects existing array edits that violate uniqueItems", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        uniqueItems: true,
        items: { type: "string" },
      },
      value: ["alpha", "beta"],
      path: ["codes"],
      onPatch,
    });
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>(".cfg-array input"));
    expect(inputs).toHaveLength(2);
    const second = expectElement(inputs[1], "second unique array item");

    second.value = "alpha";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(second.value).toBe("beta");
    expect(second.getAttribute("aria-invalid")).toBe("false");

    second.value = "gamma";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["codes"], ["alpha", "gamma"]);
  });

  it("restores boolean rows when uniqueItems rejects a toggle", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        uniqueItems: true,
        items: { type: "boolean" },
      },
      value: [false, true],
      path: ["flags"],
      onPatch,
    });
    const switches = Array.from(
      container.querySelectorAll<HTMLElement & { checked: boolean }>("wa-switch.settings-toggle"),
    );
    expect(switches).toHaveLength(2);
    const second = expectElement(switches[1], "second unique boolean item");

    second.checked = false;
    second.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(second.checked).toBe(true);
  });

  it("allows invalid arrays to be repaired one item at a time", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "array",
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
      items: { type: "string" },
    };
    const renderValue = (value: string[]) => {
      renderArrayFixture(container, {
        schema,
        value,
        path: ["codes"],
        onPatch,
      });
    };

    renderValue(["alpha", "alpha", "beta", "beta"]);
    const firstRepair = Array.from(
      container.querySelectorAll<HTMLInputElement>(".cfg-array input"),
    )[1];
    expect(firstRepair).toBeDefined();
    if (!firstRepair) {
      return;
    }
    firstRepair.value = "gamma";
    firstRepair.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["codes"], ["alpha", "gamma", "beta", "beta"]);

    onPatch.mockClear();
    renderValue(["alpha", "gamma", "beta", "beta"]);
    const secondRepair = Array.from(
      container.querySelectorAll<HTMLInputElement>(".cfg-array input"),
    )[3];
    expect(secondRepair).toBeDefined();
    if (!secondRepair) {
      return;
    }
    secondRepair.value = "delta";
    secondRepair.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["codes"], ["alpha", "gamma", "beta", "delta"]);
  });

  it("validates the resulting tuple before removing an item", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
        additionalItems: false,
      },
      value: ["identifier", 3],
      path: ["tuple"],
      onPatch,
    });

    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Remove item']"),
    );
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0]?.disabled).toBe(true);
    expect(removeButtons[1]?.disabled).toBe(false);
    const addButton = findAddButton(container);
    expect(addButton?.disabled).toBe(true);
    removeButtons[1]?.click();
    expect(onPatch).toHaveBeenCalledWith(["tuple"], ["identifier"]);
  });

  it("allows over-limit arrays to be repaired by repeated removal", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "array",
      maxItems: 2,
      items: { type: "string" },
    };
    const renderValue = (value: string[]) => {
      renderArrayFixture(container, {
        schema,
        value,
        path: ["codes"],
        onPatch,
      });
    };

    renderValue(["one", "two", "three", "four"]);
    let removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Remove item']"),
    );
    expect(removeButtons.every((button) => !button.disabled)).toBe(true);
    removeButtons[3]?.click();
    expect(onPatch).toHaveBeenLastCalledWith(["codes"], ["one", "two", "three"]);

    onPatch.mockClear();
    renderValue(["one", "two", "three"]);
    removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Remove item']"),
    );
    expect(removeButtons.every((button) => !button.disabled)).toBe(true);
    removeButtons[2]?.click();
    expect(onPatch).toHaveBeenLastCalledWith(["codes"], ["one", "two"]);
  });

  it("restores JSON rows when a collection constraint rejects the edit", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        uniqueItems: true,
        items: {
          anyOf: [{ type: "object" }, { type: "array" }],
        },
      },
      value: [{ id: "first" }, { id: "second" }],
      path: ["entries"],
      onPatch,
    });

    const textareas = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea"));
    expect(textareas).toHaveLength(2);
    const second = expectElement(textareas[1], "second JSON array item");
    second.value = '{"id":"first"}';
    second.dispatchEvent(new Event("input", { bubbles: true }));
    second.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(second.value).toContain('"second"');
    expect(second.getAttribute("aria-invalid")).toBe("false");
  });

  it("preserves an unaffected JSON row draft when another row changes", () => {
    const container = document.createElement("div");
    const schema = {
      type: "array",
      items: {
        anyOf: [{ type: "object" }, { type: "array" }],
      },
    };
    let currentValue: unknown[] = [{ id: "first" }, { id: "second" }];
    const renderValue = () => {
      renderArrayFixture(container, {
        schema,
        value: currentValue,
        path: ["entries"],
        onPatch: (_path, nextValue) => {
          currentValue = nextValue as unknown[];
          renderValue();
        },
      });
    };

    renderValue();
    let textareas = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea"));
    const first = expectElement(textareas[0], "first JSON array item");
    const second = expectElement(textareas[1], "second JSON array item");
    first.value = '{"id":';
    first.dispatchEvent(new Event("input", { bubbles: true }));
    expect(first.getAttribute("aria-invalid")).toBe("true");

    second.value = '{"id":"changed"}';
    second.dispatchEvent(new Event("input", { bubbles: true }));
    second.dispatchEvent(new Event("change", { bubbles: true }));

    textareas = Array.from(container.querySelectorAll<HTMLTextAreaElement>("textarea"));
    expect(textareas[0]?.value).toBe('{"id":');
    expect(textareas[0]?.getAttribute("aria-invalid")).toBe("true");
    expect(currentValue).toEqual([{ id: "first" }, { id: "changed" }]);
  });

  it("resets scalar and JSON drafts when the first equal primitive row is removed", () => {
    const scalarContainer = document.createElement("div");
    let scalarValue: unknown[] = ["same", "same"];
    const renderScalarValue = () => {
      renderArrayFixture(scalarContainer, {
        schema: {
          type: "array",
          items: { type: "string", minLength: 2 },
        },
        value: scalarValue,
        path: ["values"],
        onPatch: (_path, nextValue) => {
          scalarValue = nextValue as unknown[];
          renderScalarValue();
        },
      });
    };
    renderScalarValue();
    const scalarInput = expectElement(
      scalarContainer.querySelector<HTMLInputElement>("input"),
      "first equal scalar row",
    );
    scalarInput.value = "x";
    scalarInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scalarInput.getAttribute("aria-invalid")).toBe("true");
    expectElement(
      scalarContainer.querySelector<HTMLButtonElement>("button[aria-label='Remove item']"),
      "first equal scalar row remove",
    ).click();
    const remainingScalar = expectElement(
      scalarContainer.querySelector<HTMLInputElement>("input"),
      "remaining equal scalar row",
    );
    expect(remainingScalar).toBe(scalarInput);
    expect(remainingScalar.value).toBe("same");
    expect(remainingScalar.getAttribute("aria-invalid")).toBe("false");

    const jsonContainer = document.createElement("div");
    let jsonValue: unknown[] = [true, true];
    const renderJsonValue = () => {
      renderArrayFixture(jsonContainer, {
        schema: { type: "array", items: {} },
        value: jsonValue,
        path: ["values"],
        onPatch: (_path, nextValue) => {
          jsonValue = nextValue as unknown[];
          renderJsonValue();
        },
      });
    };
    renderJsonValue();
    const jsonDraft = expectElement(
      jsonContainer.querySelector<HTMLTextAreaElement>("textarea"),
      "first equal JSON row",
    );
    jsonDraft.value = "{";
    jsonDraft.dispatchEvent(new Event("input", { bubbles: true }));
    expect(jsonDraft.getAttribute("aria-invalid")).toBe("true");
    expectElement(
      jsonContainer.querySelector<HTMLButtonElement>("button[aria-label='Remove item']"),
      "first equal JSON row remove",
    ).click();
    const remainingJson = expectElement(
      jsonContainer.querySelector<HTMLTextAreaElement>("textarea"),
      "remaining equal JSON row",
    );
    expect(remainingJson).toBe(jsonDraft);
    expect(remainingJson.value).toBe("true");
    expect(remainingJson.getAttribute("aria-invalid")).toBe("false");
  });

  it("adds null through nullable scalar collection drafts", async () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    renderArrayFixture(container, {
      schema: {
        type: "array",
        uniqueItems: true,
        items: { type: ["string", "null"] },
      },
      value: [""],
      path: ["values"],
      onPatch,
    });
    const draftHost = expectElement(
      container.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "nullable scalar collection draft",
    );
    expectElement(findAddButton(container), "nullable scalar array add").click();
    await draftHost.updateComplete;
    const nullToggle = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-null]"),
      "nullable scalar null toggle",
    );
    nullToggle.checked = true;
    nullToggle.dispatchEvent(new Event("change", { bubbles: true }));
    await draftHost.updateComplete;
    expect(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]")?.disabled,
    ).toBe(true);
    expectElement(findAddButton(draftHost), "nullable scalar null commit").click();
    expect(onPatch).toHaveBeenCalledWith(["values"], ["", null]);
    container.remove();
  });

  it("propagates rejected edits through nested constrained arrays", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "array",
          items: { type: "string" },
        },
      },
      value: [["alpha"], ["beta"]],
      path: ["groups"],
      onPatch,
    });

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inputs).toHaveLength(2);
    const second = expectElement(inputs[1], "second nested array item");
    second.value = "alpha";
    second.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(second.value).toBe("beta");
    expect(second.getAttribute("aria-invalid")).toBe("false");
  });

  it("resets a reused object row after array removal", () => {
    const container = document.createElement("div");
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 2 },
        },
      },
    };
    let currentValue: unknown[] = [{ name: "same" }, { name: "same" }];
    const renderValue = () => {
      renderArrayFixture(container, {
        schema,
        value: currentValue,
        path: ["entries"],
        onPatch: (_path, nextValue) => {
          currentValue = nextValue as unknown[];
          renderValue();
        },
      });
    };

    renderValue();
    const firstInput = expectElement(
      container.querySelector<HTMLInputElement>("input"),
      "first object row input",
    );
    firstInput.value = "x";
    firstInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(firstInput.getAttribute("aria-invalid")).toBe("true");

    const firstRemove = expectElement(
      container.querySelector<HTMLButtonElement>("button[aria-label='Remove item']"),
      "first object row remove",
    );
    firstRemove.click();

    const shiftedInput = expectElement(
      container.querySelector<HTMLInputElement>("input"),
      "shifted object row input",
    );
    expect(shiftedInput.value).toBe("same");
    expect(shiftedInput.getAttribute("aria-invalid")).toBe("false");
    expect(currentValue).toEqual([{ name: "same" }]);
  });

  it("renders open tuple tail items as unconstrained JSON values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    renderArrayFixture(container, {
      schema: {
        type: "array",
        items: [{ type: "string" }],
      },
      value: ["head", { enabled: true }],
      path: ["tuple"],
      onPatch,
    });

    const tail = expectElement(
      container.querySelector<HTMLTextAreaElement>("textarea"),
      "open tuple tail JSON value",
    );
    tail.value = '{"enabled":false}';
    tail.dispatchEvent(new Event("input", { bubbles: true }));
    tail.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["tuple"], ["head", { enabled: false }]);

    const addButton = findAddButton(container);
    expect(addButton?.disabled).toBe(false);
  });
});
