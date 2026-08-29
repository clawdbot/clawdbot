import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  removeConfigFormValue,
  serializeFormForSubmit,
  updateConfigFormValue,
} from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { ConfigFormCollectionDraft } from "./config-form-collection-draft.ts";
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
          models: { "example/model": modelSettings(codeMode), "example/other": { alias: "other" } },
        }),
        tools: { codeMode: { enabled: "auto", maxOutputBytes: 4096 } },
      });
      const modelSchema = {
        type: "object",
        properties: {
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
                : { entries: { type: "object", additionalProperties: modelSchema } },
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
    ["pattern", { type: "string", pattern: "^[a-z]+$" }],
    ["minimum length", { type: "string", minLength: 1 }],
    ["enumeration", { enum: ["primary"] }],
    ["boolean", true],
    ["null", null],
    ["array", [{ type: "string" }]],
    ["wrong type", { type: "number" }],
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
