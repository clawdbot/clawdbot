// Control UI tests cover schema composition that changes field requiredness.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { renderObject } from "./config-form.node.collection.ts";
import { analyzeConfigSchema, renderConfigForm, renderNode } from "./config-form.ts";

describe("config form composition integrity", () => {
  it("keeps mixed union and allOf compositions fail-closed", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        mixed: {
          type: "string",
          anyOf: [{ const: "a" }, { const: "b" }],
          allOf: [{ const: "a" }],
        },
      },
    });

    expect(analysis.unsupportedPaths).toEqual(["mixed"]);
    expect(analysis.schema?.properties?.mixed).toMatchObject({
      anyOf: [{ const: "a" }, { const: "b" }],
      allOf: [{ const: "a" }],
    });

    const unsupportedUnion = analyzeConfigSchema({
      type: "object",
      properties: {
        mixed: {
          type: "string",
          anyOf: [{ const: "a" }, { const: "b" }],
          not: { const: "b" },
        },
      },
    });
    expect(unsupportedUnion.unsupportedPaths).toEqual(["mixed"]);
  });

  it("marks required-only object branches as form-unsafe", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        closed: {
          type: "object",
          allOf: [{ required: ["token"] }],
        },
        open: {
          type: "object",
          additionalProperties: true,
          allOf: [{ required: ["token"] }],
        },
      },
    });

    expect(analysis.unsupportedPaths).toEqual(["closed"]);
  });

  it("marks branch-scoped additional-properties schemas as form-unsafe", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        conflicting: {
          type: "object",
          allOf: [
            { properties: { count: { type: "integer" } } },
            { additionalProperties: { type: "string" } },
          ],
        },
        representable: {
          type: "object",
          allOf: [
            {
              properties: { count: { type: "integer" } },
              additionalProperties: { type: "string" },
            },
          ],
        },
      },
    });

    expect(analysis.unsupportedPaths).toEqual(["conflicting"]);
  });

  it("keeps annotations harmless and items-only schemas form-unsafe", () => {
    const annotated = analyzeConfigSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.test/config",
      type: "object",
      examples: [{}],
      deprecated: false,
      readOnly: false,
      writeOnly: false,
      properties: {
        name: { type: "string" },
      },
    });
    expect(annotated.unsupportedPaths).toEqual([]);

    const itemsOnly = analyzeConfigSchema({
      type: "object",
      properties: {
        value: {
          items: { type: "string" },
        },
      },
    });
    expect(itemsOnly.unsupportedPaths).toEqual(["value"]);
    expect(itemsOnly.schema?.properties?.value?.type).toBeUndefined();

    const composedArrayItems = analyzeConfigSchema({
      type: "object",
      properties: {
        codes: {
          type: "array",
          items: { type: "string" },
          allOf: [{ items: { pattern: "^[0-9]+$" } }],
        },
        nestedCodes: {
          type: "array",
          items: { type: "string" },
          allOf: [{ allOf: [{ minItems: 1 }] }],
        },
        nullableCodes: {
          type: ["array", "null"],
          items: { type: "string" },
          allOf: [{ allOf: [{ minItems: 1 }] }],
        },
        nullOnlyCodes: {
          type: ["array", "null"],
          items: { type: "string" },
          allOf: [{ type: ["null"] }],
        },
        nestedConflict: {
          type: "array",
          items: { type: "string" },
          allOf: [{ allOf: [{ type: "object", properties: {} }] }],
        },
      },
    });
    expect(composedArrayItems.unsupportedPaths).toEqual([
      "nullableCodes",
      "nullOnlyCodes",
      "nestedConflict",
    ]);
    expect(composedArrayItems.schema?.properties?.codes?.allOf?.[0]?.type).toBe("array");
    const nullableCodes = composedArrayItems.schema?.properties?.nullableCodes;
    expect(nullableCodes?.allOf?.[0]?.nullable).toBe(true);
    expect(isSupportedConfigValueValid(nullableCodes ?? {}, null)).toBe(true);
    const nullOnlyCodes = composedArrayItems.schema?.properties?.nullOnlyCodes;
    expect(nullOnlyCodes?.allOf?.[0]?.type).toEqual(["null"]);
    expect(isSupportedConfigValueValid(nullOnlyCodes ?? {}, null)).toBe(true);
    expect(isSupportedConfigValueValid(nullOnlyCodes ?? {}, ["123"])).toBe(false);
    const nestedConflict = composedArrayItems.schema?.properties?.nestedConflict;
    expect(isSupportedConfigValueValid(nestedConflict ?? {}, ["123"])).toBe(false);
  });

  it("does not clear fields required through allOf", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: {
            count: { type: "integer" },
          },
          allOf: [
            {
              required: ["count", "mode"],
              properties: {
                count: { minimum: 2 },
                mode: { type: "string", enum: ["a", "b", "c", "d", "e", "f"] },
              },
            },
          ],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.schema).not.toBeNull();
    if (!analysis.schema) {
      return;
    }
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { settings: { count: 3, mode: "a" } },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Count']");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenCalledWith(["settings", "count"], 2);

    onPatch.mockClear();
    const select = container.querySelector<HTMLSelectElement>("select[aria-label='Mode']");
    expect(select).not.toBeNull();
    if (!select) {
      return;
    }
    expect(select.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled).toBe(
      true,
    );
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(select.value).toBe("0");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("does not clear required JSON-backed fields", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderObject(
        {
          schema: {
            type: "object",
            properties: {
              payload: {
                anyOf: [{ type: "object" }, { type: "array" }],
              },
            },
            allOf: [{ required: ["payload"] }],
          },
          value: { payload: { enabled: true } },
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      return;
    }
    textarea.value = "";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();

    textarea.value = "123";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("preserves heterogeneous tuple schemas through analysis and rendering", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        tuple: {
          type: "array",
          items: [{ type: "string" }, { type: "integer", minimum: 2 }],
          additionalItems: false,
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    const tupleSchema = analysis.schema?.properties?.tuple;
    expect(
      Array.isArray(tupleSchema?.items) ? tupleSchema.items.map((item) => item.type) : [],
    ).toEqual(["string", "integer"]);
    if (!analysis.schema) {
      return;
    }

    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { tuple: ["head", 2] },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch: vi.fn(),
      }),
      container,
    );
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>(".cfg-array input"));
    expect(inputs.map((input) => input.type)).toEqual(["text", "number"]);
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add",
    );
    expect(add?.disabled).toBe(true);
  });

  it("rejects child edits that violate composed object constraints", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: {
            mode: { type: "string" },
          },
          allOf: [{ const: { mode: "safe" } }],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    if (!analysis.schema) {
      return;
    }

    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { settings: { mode: "safe" } },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );
    const mode = container.querySelector<HTMLInputElement>("input[aria-label='Mode']");
    expect(mode).not.toBeNull();
    if (!mode) {
      return;
    }
    mode.value = "fast";
    mode.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mode.value).toBe("safe");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("renders and enforces additional properties composed through allOf", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        aliases: {
          type: "object",
          allOf: [
            {
              additionalProperties: { type: "string", minLength: 2 },
            },
          ],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    if (!analysis.schema) {
      return;
    }

    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { aliases: { custom: "ok" } },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
    ).toBe(true);
    const custom = container.querySelector<HTMLInputElement>("input[aria-label='Custom']");
    expect(custom).not.toBeNull();
    if (!custom) {
      return;
    }
    custom.value = "x";
    custom.dispatchEvent(new Event("input", { bubbles: true }));
    expect(custom.value).toBe("x");
    expect(custom.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("lets additionalProperties false dominate composed map policies", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        aliases: {
          type: "object",
          additionalProperties: { type: "string" },
          allOf: [{ additionalProperties: false }],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    if (!analysis.schema) {
      return;
    }

    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { aliases: {} },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch: vi.fn(),
      }),
      container,
    );
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
    ).toBe(false);
  });

  it("infers nested and compatible allOf types while rejecting impossible intersections", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        nested: {
          allOf: [{ allOf: [{ type: "string", minLength: 2 }] }],
        },
        numeric: {
          allOf: [{ type: "number" }, { type: "integer", minimum: 2 }],
        },
        impossible: {
          allOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual(["impossible"]);
    expect(analysis.schema?.properties?.nested?.type).toBe("string");
    expect(analysis.schema?.properties?.numeric?.type).toBe("integer");
    if (!analysis.schema) {
      return;
    }

    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { nested: "ok", numeric: 2, impossible: "raw-only" },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );
    const nested = container.querySelector<HTMLInputElement>("input[aria-label='Nested']");
    const numeric = container.querySelector<HTMLInputElement>("input[aria-label='Numeric']");
    expect(nested?.type).toBe("text");
    expect(numeric?.type).toBe("number");
    if (!nested) {
      return;
    }
    nested.value = "x";
    nested.dispatchEvent(new Event("input", { bubbles: true }));
    expect(nested.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("marks ambiguous non-null type arrays as form-unsafe", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        numberFirst: { type: ["number", "string"] },
        stringFirst: { type: ["string", "number"] },
      },
    });
    expect(analysis.unsupportedPaths).toEqual(["numberFirst", "stringFirst"]);
  });

  it("marks allOf branches with unenforced constraint keywords as form-unsafe", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        strictObject: {
          type: "object",
          additionalProperties: true,
          allOf: [{ minProperties: 1 }],
        },
        strictArray: {
          type: "array",
          items: { type: "string" },
          allOf: [{ contains: { const: "required" } }],
        },
        typedObject: {
          allOf: [{ type: "object", minProperties: 1 }],
        },
        nestedConstraint: {
          allOf: [
            {
              type: "object",
              properties: {
                child: { minProperties: 1 },
              },
            },
          ],
        },
        outerConstraint: {
          type: "array",
          items: { type: "string" },
          contains: { const: "required" },
          allOf: [{ maxItems: 3 }],
        },
        plainConstraint: {
          type: "array",
          items: { type: "string" },
          contains: { const: "required" },
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([
      "strictObject",
      "strictArray",
      "typedObject",
      "nestedConstraint.child",
      "outerConstraint",
      "plainConstraint",
    ]);
  });

  it("marks incompatible effective allOf child schemas as form-unsafe", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: {
            mode: { type: "string" },
          },
          allOf: [
            {
              properties: {
                mode: { type: "number" },
                constraintOnly: { const: "safe" },
              },
            },
          ],
        },
        mixedItems: {
          type: "array",
          items: { type: "string" },
          allOf: [{ items: { type: "number" } }],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([
      "settings.mode",
      "settings.constraintOnly",
      "mixedItems",
    ]);
  });

  it("preserves nullability inherited through allOf", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        inherited: {
          allOf: [{ type: ["string", "null"] }],
        },
        excludedByOuterType: {
          type: "string",
          allOf: [{ type: ["string", "null"] }],
        },
        unionTypeExcludesNull: {
          type: "string",
          anyOf: [{ const: "fixed" }, { const: null }],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual(["inherited"]);
    expect(analysis.schema?.properties?.inherited).toMatchObject({
      type: "string",
      nullable: true,
    });
    expect(analysis.schema?.properties?.excludedByOuterType).toMatchObject({
      type: "string",
      nullable: false,
    });
    expect(analysis.schema?.properties?.unionTypeExcludesNull).toMatchObject({
      nullable: false,
      enumIncludesNull: false,
    });
  });

  it("preserves whether nullable enums actually include null", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        excludesNull: {
          type: ["string", "null"],
          enum: ["fixed"],
        },
        includesNull: {
          type: ["string", "null"],
          enum: ["fixed", null],
        },
        typeExcludesNull: {
          type: "string",
          enum: ["fixed", null],
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.schema?.properties?.excludesNull?.enumIncludesNull).toBe(false);
    expect(analysis.schema?.properties?.includesNull?.enumIncludesNull).toBe(true);
    expect(analysis.schema?.properties?.typeExcludesNull).toMatchObject({
      nullable: false,
      enumIncludesNull: false,
    });
  });

  it("keeps type-less allOf fields unsafe and closed empty tuples repairable", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        unknown: { allOf: [{ minLength: 2 }] },
        empty: {
          type: "array",
          items: [],
          additionalItems: false,
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual(["unknown"]);
    if (!analysis.schema) {
      return;
    }

    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { unknown: "raw-only", empty: ["invalid"] },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Add",
    );
    expect(add?.disabled).toBe(true);
    const remove = container.querySelector<HTMLButtonElement>("button[aria-label='Remove item']");
    expect(remove?.disabled).toBe(false);
    remove?.click();
    expect(onPatch).toHaveBeenCalledWith(["empty"], []);
  });
});
