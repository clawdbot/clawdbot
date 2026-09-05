import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  removeConfigFormValue,
  serializeFormForSubmit,
  updateConfigFormValue,
} from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { ConfigFormCollectionDraft } from "./config-form-collection-draft.ts";
import type { JsonSchema } from "./config-form.shared.ts";
import { analyzeConfigSchema, renderConfigForm } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form map integrity", () => {
  it.each(["defaults", "agent"])(
    "round-trips the %s model Code Mode field without losing sibling settings",
    (scope) => {
      const wrapScope = (value: unknown) =>
        scope === "defaults" ? { defaults: value } : { entries: { ops: value } };
      const modelSettings = (codeMode?: boolean) => ({
        alias: "test",
        params: { temperature: 0.5 },
        agentRuntime: { id: "openclaw" },
        streaming: false,
        ...(codeMode === undefined ? {} : { codeMode }),
      });
      const config = (codeMode?: boolean) => ({
        agents: wrapScope({
          models: {
            "example/model.v1": modelSettings(codeMode),
            "example/other": { alias: "other" },
          },
          ...(scope === "agent"
            ? { tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } } }
            : {}),
        }),
        tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
      });
      const modelSchema = {
        type: "object",
        properties: {
          ...(scope === "agent"
            ? {
                tools: {
                  type: "object",
                  properties: {
                    codeMode: {
                      anyOf: [
                        { type: "boolean" },
                        { const: "auto" },
                        { type: "object", additionalProperties: true },
                      ],
                    },
                  },
                },
              }
            : {}),
          models: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                alias: { type: "string" },
                params: { type: "object", properties: { temperature: { type: "number" } } },
                agentRuntime: { type: "object", properties: { id: { type: "string" } } },
                streaming: { type: "boolean" },
                codeMode: { type: "boolean" },
              },
            },
          },
        },
      };
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          agents: {
            type: "object",
            properties:
              scope === "defaults"
                ? { defaults: modelSchema }
                : {
                    entries: {
                      type: "object",
                      propertyNames: { type: "string", pattern: "^[a-z0-9_][a-z0-9_-]{0,63}$" },
                      additionalProperties: modelSchema,
                    },
                  },
          },
        },
      });
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configForm = config();
      const container = document.createElement("div");
      const renderValue = () =>
        render(
          renderConfigForm({
            schema: analysis.schema,
            uiHints: {
              "agents.defaults.models.*.codeMode": { label: "Code Mode", placeholder: "Default" },
              "agents.entries.*.models.*.codeMode": { label: "Code Mode", placeholder: "Default" },
            },
            unsupportedPaths: analysis.unsupportedPaths,
            value: state.configForm,
            showAdvanced: true,
            onShowAdvanced: () => {},
            onPatch: (path, value) => updateConfigFormValue(state, path, value),
            onRemove: (path) => removeConfigFormValue(state, path),
          }),
          container,
        );
      const getSelect = () =>
        expectElement(
          container.querySelector<HTMLSelectElement>('select[aria-label="Code Mode"]'),
          "model Code Mode selector",
        );

      renderValue();
      if (scope === "agent") {
        expect(container.textContent).toContain("Unsupported schema node. Use Raw mode.");
      }
      expect(Array.from(getSelect().options, (option) => option.textContent?.trim())).toEqual([
        "Default",
        "On",
        "Off",
      ]);
      expect(getSelect().selectedOptions[0]?.textContent?.trim()).toBe("Default");
      const streamingRow = Array.from(container.querySelectorAll(".settings-row--toggle")).find(
        (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === "Streaming",
      );
      expect(streamingRow?.querySelector("wa-switch")).toBeTruthy();

      for (const [label, value] of [
        ["On", true],
        ["Off", false],
        ["Default", undefined],
      ] as const) {
        const select = getSelect();
        const option = expectElement(
          Array.from(select.options).find((entry) => entry.textContent?.trim() === label),
          label,
        );
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        expect(JSON.parse(serializeFormForSubmit(state))).toEqual(config(value));
        renderValue();
        expect(getSelect().selectedOptions[0]?.textContent?.trim()).toBe(label);
      }
    },
  );

  it("keeps plain-string record keys editable through nested maps", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        values: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {
            type: "object",
            propertyNames: { type: "string" },
            additionalProperties: { type: "string" },
          },
        },
      },
    });

    expect(analysis.unsupportedPaths).toEqual([]);

    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { values: { primary: { region: "west" } } },
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch,
      }),
      container,
    );

    expect(container.querySelectorAll(".cfg-map")).toHaveLength(2);
    expect(container.textContent).not.toContain("Unsupported schema node");

    const nestedKey = expectElement(
      container.querySelector<HTMLInputElement>('[aria-label="Key: region"]'),
      "nested map key",
    );
    nestedKey.value = "zone";
    nestedKey.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["values", "primary"], { zone: "west" });
  });

  it.each([
    ["boolean", true],
    ["null", null],
    ["array", [{ type: "string" }]],
    ["wrong type", { type: "number" }],
    ["unknown constraint", { type: "string", not: { const: "blocked" } }],
    ["inherited type", Object.assign(Object.create({ type: "string" }), { unknown: true })],
  ])("keeps %s property-name constraints fail-closed", (_label, propertyNames) => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        values: {
          type: "object",
          propertyNames,
          additionalProperties: { type: "string" },
        },
      },
    });

    expect(analysis.unsupportedPaths).toEqual(["values"]);
  });

  it.each([
    { label: "pattern", names: { type: "string", pattern: "^[a-z]+$" }, invalid: "bad/key" },
    { label: "minimum length", names: { type: "string", minLength: 3 }, invalid: "x" },
    { label: "enumeration", names: { enum: ["primary", "backup"] }, invalid: "other" },
    {
      label: "intersection",
      names: { allOf: [{ minLength: 3 }, { pattern: "^[a-z]+$" }] },
      invalid: "bad/key",
    },
  ])(
    "rejects $label key edits even when an existing value is invalid",
    async ({ names, invalid }) => {
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          values: {
            type: "object",
            propertyNames: names,
            additionalProperties: { type: "string", pattern: "^[0-9]+$" },
          },
        },
      });
      expect(analysis.unsupportedPaths).toEqual([]);
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configForm = { values: { primary: "invalid existing value" } };
      const onPatch = vi.fn((path: Array<string | number>, value: unknown) =>
        updateConfigFormValue(state, path, value),
      );
      const container = document.createElement("div");
      document.body.append(container);
      try {
        render(
          renderConfigForm({
            schema: analysis.schema,
            uiHints: {},
            unsupportedPaths: analysis.unsupportedPaths,
            value: state.configForm,
            showAdvanced: true,
            onShowAdvanced: () => {},
            onPatch,
          }),
          container,
        );
        const keyInput = expectElement(
          container.querySelector<HTMLInputElement>('[aria-label="Key: primary"]'),
          "existing key",
        );
        keyInput.value = invalid;
        keyInput.dispatchEvent(new Event("change", { bubbles: true }));
        expect(keyInput.value).toBe("primary");
        expect(onPatch).not.toHaveBeenCalled();

        const draft = expectElement(
          container.querySelector<ConfigFormCollectionDraft>(
            "openclaw-config-form-collection-draft",
          ),
          "map draft",
        );
        expectElement(
          Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Add Entry",
          ),
          "add entry",
        ).click();
        await draft.updateComplete;
        const key = expectElement(
          draft.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
          "draft key",
        );
        const value = expectElement(
          draft.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
          "draft value",
        );
        key.value = invalid;
        key.dispatchEvent(new Event("input", { bubbles: true }));
        value.value = "123";
        value.dispatchEvent(new Event("input", { bubbles: true }));
        await draft.updateComplete;
        expectElement(
          Array.from(draft.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Add Entry",
          ),
          "commit entry",
        ).click();
        await draft.updateComplete;
        expect(key.getAttribute("aria-invalid")).toBe("true");
        expect(key.value).toBe(invalid);
        expect(onPatch).not.toHaveBeenCalled();
        key.value = "backup";
        key.dispatchEvent(new Event("input", { bubbles: true }));
        await draft.updateComplete;
        expectElement(
          Array.from(draft.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Add Entry",
          ),
          "commit valid entry",
        ).click();
        expect(state.configForm).toEqual({
          values: { primary: "invalid existing value", backup: "123" },
        });
      } finally {
        container.remove();
      }
    },
  );

  it.each(["map", "array"])(
    "keeps supported %s children editable beside Raw-only fields",
    (kind) => {
      const rowSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          retained: { anyOf: [{ type: "string" }, { const: false }] },
        },
      } satisfies JsonSchema;
      const collection = (name: string) =>
        kind === "map"
          ? { "example/model.v1": { name, retained: false } }
          : [{ name, retained: false }];
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          values:
            kind === "map"
              ? { type: "object", additionalProperties: rowSchema }
              : { type: "array", items: rowSchema },
        },
      });
      expect(analysis.unsupportedPaths).toEqual(["values.*.retained"]);
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configForm = { values: collection("before") };
      const container = document.createElement("div");
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: {},
          unsupportedPaths: analysis.unsupportedPaths,
          value: state.configForm,
          showAdvanced: true,
          onShowAdvanced: () => {},
          onPatch: (path, value) => updateConfigFormValue(state, path, value),
        }),
        container,
      );
      expect(container.textContent).toContain("Unsupported schema node. Use Raw mode.");
      expect(container.querySelector('[aria-label="Retained"]')).toBeNull();
      const name = expectElement(
        container.querySelector<HTMLInputElement>('[aria-label="Name"]'),
        "supported name field",
      );
      name.value = "after";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      expect(JSON.parse(serializeFormForSubmit(state))).toEqual({ values: collection("after") });
    },
  );

  it("retains unset map drafts until the collection source changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        aliases: {
          type: "object",
          additionalProperties: {
            type: "string",
            pattern: "^[0-9]+$",
          },
        },
      },
    });
    const renderValue = (aliases: Record<string, unknown> | undefined) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: {},
          unsupportedPaths: analysis.unsupportedPaths,
          value: aliases === undefined ? {} : { aliases },
          showAdvanced: true,
          onShowAdvanced: () => {},
          onPatch: () => {},
        }),
        container,
      );
    };

    renderValue(undefined);
    const map = expectElement(container.querySelector<HTMLElement>(".cfg-map"), "unset map");
    const draftHost = expectElement(
      map.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "unset map draft host",
    );
    expectElement(
      Array.from(map.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
      "unset map add button",
    ).click();
    await draftHost.updateComplete;
    const key = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
      "unset map draft key",
    );
    const value = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "unset map draft value",
    );
    key.value = "primary";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    value.value = "123";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await draftHost.updateComplete;

    renderValue(undefined);
    await draftHost.updateComplete;
    expect(
      expectElement(
        draftHost.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
        "preserved unset map draft key",
      ).value,
    ).toBe("primary");
    expect(
      expectElement(
        draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
        "preserved unset map draft value",
      ).value,
    ).toBe("123");

    renderValue({});
    await draftHost.updateComplete;
    expect(draftHost.querySelector(".cfg-collection-draft")).toBeNull();
    container.remove();
  });
});
