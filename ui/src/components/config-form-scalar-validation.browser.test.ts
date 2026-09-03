import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptConfigSetAck,
  applyConfigSnapshot,
  updateConfigFormValue,
} from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { analyzeConfigSchema, renderConfigForm } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("scalar validation error accessibility", () => {
  const containers: HTMLDivElement[] = [];
  afterEach(() => {
    for (const container of containers) {
      render(nothing, container);
      container.remove();
    }
    containers.length = 0;
  });

  function renderScalarForm(schema: object, value: Record<string, unknown> | null = null) {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const analysis = analyzeConfigSchema(schema);
    const renderValue = (next: Record<string, unknown> | null) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: {},
          unsupportedPaths: analysis.unsupportedPaths,
          value: next,
          showAdvanced: true,
          onShowAdvanced: () => {},
          onPatch,
        }),
        container,
      );
    };
    renderValue(value);
    return { container, onPatch, renderValue };
  }

  function feedback(input: HTMLInputElement) {
    const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const descriptions = ids.map((id) => {
      const matches = [...document.querySelectorAll<HTMLElement>("[id]")].filter(
        (element) => element.id === id,
      );
      expect(matches).toHaveLength(1);
      return expectElement(matches[0], "linked description");
    });
    const errors = descriptions.filter((element) => element.getAttribute("role") === "alert");
    expect(errors).toHaveLength(1);
    return {
      error: expectElement(errors[0], "linked validation error"),
      help: descriptions.filter((element) => element.getAttribute("role") !== "alert"),
    };
  }

  it("explains a rejected string draft, preserves its help, and clears feedback on correction", () => {
    const { container, onPatch } = renderScalarForm(
      {
        type: "object",
        required: ["settings"],
        properties: {
          settings: {
            type: "object",
            required: ["name"],
            properties: {
              name: {
                type: "string",
                description: "Use at least two lowercase letters.",
                pattern: "[a-z]+",
                minLength: 2,
              },
            },
          },
        },
      },
      { settings: { name: "aa" } },
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
      "string input",
    );
    expect(input.value).toBe("aa");
    const { error, help } = feedback(input);
    expect(help.map((element) => element.textContent)).toEqual([
      "Use at least two lowercase letters.",
    ]);
    expect(error.hidden).toBe(true);

    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("1");
    expect(input.validity.valid).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(input.validationMessage);
    expect(input.validationMessage).not.toBe("");
    expect(onPatch).not.toHaveBeenCalled();

    input.value = "ab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenLastCalledWith(["settings", "name"], "ab");
    expect(input.validity.valid).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
    expect(feedback(input).help.map((element) => element.textContent)).toEqual([
      "Use at least two lowercase letters.",
    ]);
  });

  it.each([
    ["below the minimum", "0"],
    ["above the maximum", "10"],
    ["off the allowed step", "3"],
    ["required but empty", ""],
  ])("explains a numeric draft that is %s without committing it", (_reason, value) => {
    const { container, onPatch } = renderScalarForm(
      {
        type: "object",
        required: ["settings"],
        properties: {
          settings: {
            type: "object",
            required: ["count"],
            properties: {
              count: { type: "integer", minimum: 2, maximum: 8, multipleOf: 2 },
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
    const { error } = feedback(input);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe(value);
    expect(input.validity.valid).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(input.validationMessage);
    expect(input.validationMessage).not.toBe("");
    expect(onPatch).not.toHaveBeenCalled();

    input.value = "6";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenLastCalledWith(["settings", "count"], 6);
    expect(input.validity.valid).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
  });

  it("clears stale feedback when an authoritative value refresh replaces a blurred draft", () => {
    const { container, onPatch, renderValue } = renderScalarForm(
      {
        type: "object",
        required: ["settings"],
        properties: {
          settings: {
            type: "object",
            required: ["port"],
            properties: { port: { type: "integer", minimum: 1, maximum: 65535 } },
          },
        },
      },
      { settings: { port: 443 } },
    );
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "number input",
    );
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(feedback(input).error.hidden).toBe(false);
    expect(onPatch).not.toHaveBeenCalled();

    renderValue({ settings: { port: 8080 } });
    const refreshed = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "refreshed number input",
    );
    expect(refreshed.value).toBe("8080");
    expect(refreshed.validity.valid).toBe(true);
    expect(refreshed.getAttribute("aria-invalid")).toBe("false");
    expect(feedback(refreshed).error.hidden).toBe(true);
    expect(feedback(refreshed).error.textContent).toBe("");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "scalar", target: "empty", nextValue: "" },
    { kind: "scalar", target: "nonempty", nextValue: "456" },
    { kind: "json", target: "empty", nextValue: {} },
    { kind: "json", target: "nonempty", nextValue: { credential: "456" } },
  ])(
    "clears $kind feedback after a sensitive value becomes $target",
    ({ kind, target, nextValue }) => {
      const isJson = kind === "json";
      const onPatch = vi.fn();
      const container = document.createElement("div");
      document.body.append(container);
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: isJson
          ? { accounts: { type: "object", additionalProperties: true } }
          : { apiKey: { type: "string", pattern: "^[0-9]*$" } },
      });
      const renderValue = (value: unknown) => {
        render(
          renderConfigForm({
            schema: analysis.schema,
            uiHints: { [isJson ? "accounts.primary.credential" : "apiKey"]: { sensitive: true } },
            unsupportedPaths: analysis.unsupportedPaths,
            value: isJson ? { accounts: { primary: value } } : { apiKey: value },
            showAdvanced: true,
            onShowAdvanced: () => {},
            revealSensitive: true,
            onToggleSensitivePath: () => {},
            onPatch,
          }),
          container,
        );
      };
      const getControl = () =>
        expectElement(
          container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            isJson ? "textarea[aria-label='primary: JSON value']" : "input[aria-label='Api Key']",
          ),
          "revealed sensitive control",
        );
      const getError = () =>
        expectElement(container.querySelector<HTMLElement>("[role='alert']"), "validation reason");

      try {
        renderValue(isJson ? { credential: "123" } : "123");
        const input = getControl();
        const error = getError();
        expect(input.readOnly).toBe(false);
        expect(input.value).toBe(isJson ? JSON.stringify({ credential: "123" }, null, 2) : "123");
        expect(container.querySelector("button[aria-pressed='true']")).not.toBeNull();
        expect(input.getAttribute("aria-describedby")?.split(/\s+/)).toContain(error.id);
        expect(error.hidden).toBe(true);

        input.focus();
        input.value = isJson ? "{" : "abc";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        expect(input.validity.valid).toBe(false);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe(input.validationMessage);
        expect(onPatch).not.toHaveBeenCalled();

        renderValue(nextValue);
        const refreshed = getControl();
        const refreshedError = getError();
        expect(refreshed.value).toBe(isJson ? JSON.stringify(nextValue, null, 2) : nextValue);
        expect(refreshed.readOnly).toBe(false);
        expect(refreshed.validity.valid).toBe(true);
        expect(refreshed.validationMessage).toBe("");
        expect(refreshed.getAttribute("aria-invalid")).toBe("false");
        expect(refreshed.getAttribute("aria-describedby")?.split(/\s+/)).toContain(
          refreshedError.id,
        );
        expect(Boolean(container.querySelector("button[aria-pressed='true']"))).toBe(
          target === "nonempty",
        );
        expect(onPatch).not.toHaveBeenCalled();
        expect(refreshedError.hidden).toBe(true);
        expect(refreshedError.textContent).toBe("");
      } finally {
        render(null, container);
        container.remove();
      }
    },
  );

  it.each([
    { from: "number", to: "text" },
    { from: "text", to: "number" },
    { from: "number", to: "number" },
    { from: "text", to: "text" },
  ])("clears feedback when a Settings section switches from $from to $to", ({ from, to }) => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const fieldSchema = (kind: string, description: string) =>
      kind === "number"
        ? { type: "integer", minimum: 2, maximum: 8, multipleOf: 2, description }
        : { type: "string", pattern: "^[a-z]+$", minLength: 2, description };
    const analysis = analyzeConfigSchema({
      type: "object",
      required: ["first", "second"],
      properties: {
        first: {
          type: "object",
          required: ["value"],
          properties: { value: fieldSchema(from, "First value help.") },
        },
        second: {
          type: "object",
          required: ["value"],
          properties: { value: fieldSchema(to, "Second value help.") },
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
    const renderSection = (activeSection: string) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: {},
          unsupportedPaths: analysis.unsupportedPaths,
          value: {
            first: { value: from === "number" ? 4 : "aa" },
            second: { value: to === "number" ? 6 : "bb" },
          },
          activeSection,
          showAdvanced: true,
          onShowAdvanced: () => {},
          onPatch,
        }),
        container,
      );
    };
    const getInput = () =>
      expectElement(
        container.querySelector<HTMLInputElement>("input[aria-label='Value']"),
        "active section input",
      );

    renderSection("first");
    const input = getInput();
    expect(input.type).toBe(from);
    expect(input.value).toBe(from === "number" ? "4" : "aa");
    expect(feedback(input).help.map((element) => element.textContent)).toEqual([
      "First value help.",
    ]);
    expect(feedback(input).error.hidden).toBe(true);
    input.focus();
    input.value = from === "number" ? "3" : "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.blur();
    expect(input.validity.valid).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(feedback(input).error.hidden).toBe(false);
    expect(feedback(input).error.textContent).toBe(input.validationMessage);
    expect(input.validationMessage).not.toBe("");
    expect(onPatch).not.toHaveBeenCalled();

    renderSection("second");
    const refreshed = getInput();
    expect(refreshed.type).toBe(to);
    expect(refreshed.value).toBe(to === "number" ? "6" : "bb");
    expect(refreshed.validity.valid).toBe(true);
    expect(refreshed.validationMessage).toBe("");
    expect(refreshed.getAttribute("aria-invalid")).toBe("false");
    expect(feedback(refreshed).help.map((element) => element.textContent)).toEqual([
      "Second value help.",
    ]);
    expect(onPatch).not.toHaveBeenCalled();
    expect(feedback(refreshed).error.hidden).toBe(true);
    expect(feedback(refreshed).error.textContent).toBe("");

    refreshed.value = to === "number" ? "8" : "cc";
    refreshed.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenLastCalledWith(["second", "value"], to === "number" ? 8 : "cc");
    expect(refreshed.validity.valid).toBe(true);
    expect(feedback(refreshed).error.hidden).toBe(true);
  });

  it.each(["masked", "revealed"] as const)(
    "applies the %s presentation to an accepted focused sensitive value",
    (presentation) => {
      const onPatch = vi.fn();
      const container = document.createElement("div");
      containers.push(container);
      document.body.append(container);
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: { apiKey: { type: "string" } },
      });
      const renderValue = (apiKey: string) => {
        render(
          renderConfigForm({
            schema: analysis.schema,
            uiHints: { apiKey: { sensitive: true } },
            unsupportedPaths: analysis.unsupportedPaths,
            value: { apiKey },
            showAdvanced: true,
            onShowAdvanced: () => {},
            revealSensitive: presentation === "revealed",
            onToggleSensitivePath: () => {},
            onPatch,
          }),
          container,
        );
      };
      const getInput = () =>
        expectElement(
          container.querySelector<HTMLInputElement>("input[aria-label='Api Key']"),
          "sensitive input",
        );
      renderValue("");
      const input = getInput();
      expect(input.value).toBe("");
      expect(input.readOnly).toBe(false);
      input.focus();
      input.value = "sample-value";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(document.activeElement).toBe(input);
      expect(input.validity.valid).toBe(true);
      expect(onPatch).toHaveBeenCalledExactlyOnceWith(["apiKey"], "sample-value");

      renderValue("sample-value");
      const accepted = getInput();
      expect(accepted.readOnly).toBe(presentation === "masked");
      expect(accepted.classList.contains("cfg-redacted")).toBe(presentation === "masked");
      expect(accepted.getAttribute("aria-invalid")).toBe("false");
      expect(feedback(accepted).error.hidden).toBe(true);
      expect(onPatch).toHaveBeenCalledExactlyOnceWith(["apiKey"], "sample-value");
      expect(accepted.value).toBe(presentation === "masked" ? "" : "sample-value");
    },
  );

  it("masks an accepted focused JSON value without replaying its write", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: { accounts: { type: "object", additionalProperties: true } },
    });
    const renderValue = (primary: Record<string, string>) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: { "accounts.primary.credential": { sensitive: true } },
          unsupportedPaths: analysis.unsupportedPaths,
          value: { accounts: { primary } },
          showAdvanced: true,
          onShowAdvanced: () => {},
          onToggleSensitivePath: () => {},
          onPatch,
        }),
        container,
      );
    };
    const getInput = () =>
      expectElement(
        container.querySelector<HTMLTextAreaElement>("textarea[aria-label='primary: JSON value']"),
        "JSON input",
      );
    renderValue({});
    const input = getInput();
    expect(input.value).toBe("{}");
    expect(input.readOnly).toBe(false);
    input.focus();
    input.value = '{"credential":"sample-value"}';
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.activeElement).toBe(input);
    expect(input.validity.valid).toBe(true);
    expect(onPatch).toHaveBeenCalledExactlyOnceWith(["accounts", "primary"], {
      credential: "sample-value",
    });
    renderValue({ credential: "sample-value" });
    const accepted = getInput();
    expect(accepted.readOnly).toBe(true);
    expect(accepted.classList.contains("cfg-redacted")).toBe(true);
    expect(accepted.getAttribute("aria-invalid")).toBe("false");
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(accepted.value).toBe("");
  });

  it("resets a focused draft when Settings switches to a different field path", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const field = (description: string) => ({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", pattern: "^[a-z]+$", minLength: 2, description } },
    });
    const analysis = analyzeConfigSchema({
      type: "object",
      required: ["first", "second"],
      properties: { first: field("First field help."), second: field("Second field help.") },
    });
    const renderSection = (activeSection: string) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: {},
          unsupportedPaths: analysis.unsupportedPaths,
          value: { first: { name: "aa" }, second: { name: "aa" } },
          activeSection,
          showAdvanced: true,
          onShowAdvanced: () => {},
          onPatch,
        }),
        container,
      );
    };
    const getInput = () =>
      expectElement(
        container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
        "active field",
      );
    renderSection("first");
    const input = getInput();
    expect(input.value).toBe("aa");
    input.focus();
    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.activeElement).toBe(input);
    expect(input.validity.valid).toBe(false);
    expect(feedback(input).error.hidden).toBe(false);
    expect(onPatch).not.toHaveBeenCalled();
    renderSection("second");
    const next = getInput();
    expect(feedback(next).help.map((element) => element.textContent)).toEqual([
      "Second field help.",
    ]);
    expect(onPatch).not.toHaveBeenCalled();
    expect(next.value).toBe("aa");
    expect(next.validity.valid).toBe(true);
    expect(next.getAttribute("aria-invalid")).toBe("false");
    expect(feedback(next).error.hidden).toBe(true);
    expect(feedback(next).error.textContent).toBe("");
  });

  it.each([
    ["scalar", "snapshot"],
    ["json", "snapshot"],
    ["scalar", "sibling snapshot"],
    ["json", "sibling snapshot"],
    ["scalar", "removal"],
    ["json", "removal"],
    ["scalar", "ack"],
    ["json", "ack"],
    ["scalar", "sibling patch"],
    ["json", "sibling patch"],
    ["scalar", "shape replacement"],
    ["json", "shape replacement"],
  ])("keeps %s row draft ownership through %s adoption", async (kind, transition) => {
    const isJson = kind === "json";
    const shapeReplacement = transition === "shape replacement";
    const state = createInitialConfigState();
    const fieldValue = isJson ? { value: 1 } : "same";
    const sourceRow = shapeReplacement
      ? { name: fieldValue, meta: { 0: "x", length: 1 } }
      : { name: "same" };
    const sourceConfig = { entries: [structuredClone(sourceRow), structuredClone(sourceRow)] };
    const snapshot = (config: { entries: unknown[] } = sourceConfig) => ({
      sourceConfig: structuredClone(config),
      raw: JSON.stringify(config),
      hash: "snapshot-row-revision",
      valid: true,
      issues: [],
    });
    applyConfigSnapshot(state, snapshot());
    await state.configRawOriginalParsePending;
    const analysis = analyzeConfigSchema({
      type: "object",
      required: ["entries"],
      properties: {
        entries: {
          type: "array",
          items:
            isJson && !shapeReplacement
              ? { anyOf: [{ type: "object" }, { type: "array" }] }
              : {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: isJson
                      ? { anyOf: [{ type: "object" }, { type: "array" }] }
                      : { type: "string", minLength: 2 },
                  },
                },
        },
      },
    });
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const onPatch = vi.fn((path: Array<string | number>, value: unknown) => {
      updateConfigFormValue(state, path, value);
      renderValue();
    });
    const renderValue = () => {
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
    };
    const controls = () => [
      ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        isJson ? ".cfg-array textarea" : "input[aria-label='Name']",
      ),
    ];
    const errorFor = (input: HTMLInputElement | HTMLTextAreaElement) => {
      const descriptions = (input.getAttribute("aria-describedby") ?? "").split(/\s+/);
      return expectElement(
        [...container.querySelectorAll<HTMLElement>("[role='alert']")].find((error) =>
          descriptions.includes(error.id),
        ),
        "linked row validation error",
      );
    };
    renderValue();
    expect(controls()).toHaveLength(2);
    const input = expectElement(controls()[0], "first object row control");
    const draft = isJson ? "{" : "x";
    input.focus();
    input.value = draft;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.activeElement).toBe(input);
    expect(input.validity.valid).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(errorFor(input).hidden).toBe(false);
    expect(errorFor(input).textContent).toBe(input.validationMessage);
    expect(input.validationMessage).not.toBe("");
    expect(onPatch).not.toHaveBeenCalled();
    expect(state.configFormDirty).toBe(false);
    expect(state.configForm).toEqual(sourceConfig);

    if (shapeReplacement) {
      const replacement = {
        entries: [
          { name: structuredClone(fieldValue), meta: ["x"] },
          { name: structuredClone(fieldValue), meta: ["x"] },
        ],
      };
      applyConfigSnapshot(state, snapshot(replacement));
      await state.configRawOriginalParsePending;
      renderValue();
      const refreshed = expectElement(controls()[0], "replaced row field");
      expect(controls()).toHaveLength(2);
      expect(document.activeElement).toBe(refreshed);
      expect(state.configForm).toEqual(replacement);
      expect(state.configFormDirty).toBe(false);
      expect(onPatch).not.toHaveBeenCalled();
      expect(refreshed.value).toBe(isJson ? JSON.stringify(fieldValue, null, 2) : "same");
      expect(refreshed.validity.valid).toBe(true);
      expect(refreshed.getAttribute("aria-invalid")).toBe("false");
      expect(errorFor(refreshed).hidden).toBe(true);
      expect(errorFor(refreshed).textContent).toBe("");

      const nextValue = isJson ? { value: 2 } : "next";
      refreshed.value = isJson ? JSON.stringify(nextValue) : "next";
      refreshed.dispatchEvent(new Event("input", { bubbles: true }));
      if (isJson) {
        refreshed.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const expectedEntries = [{ name: nextValue, meta: ["x"] }, replacement.entries[1]];
      expect(onPatch).toHaveBeenCalledExactlyOnceWith(["entries"], expectedEntries);
      expect(state.configForm).toEqual({ entries: expectedEntries });
      expect(state.configFormDirty).toBe(true);
    } else if (transition !== "removal") {
      if (transition === "snapshot" || transition === "sibling snapshot") {
        applyConfigSnapshot(
          state,
          snapshot(
            transition === "sibling snapshot"
              ? { entries: [sourceConfig.entries[0], { name: "updated" }] }
              : sourceConfig,
          ),
        );
      } else if (transition === "ack") {
        adoptConfigSetAck(state, snapshot().raw, "ack-row-revision");
        expect(state.configSnapshot?.hash).toBe("ack-row-revision");
      } else {
        updateConfigFormValue(state, ["entries", 1, "name"], "updated");
      }
      await state.configRawOriginalParsePending;
      renderValue();
      const refreshed = expectElement(controls()[0], "refreshed focused row");
      expect(controls()).toHaveLength(2);
      expect(document.activeElement).toBe(refreshed);
      expect(state.configForm).toEqual(
        transition === "sibling patch" || transition === "sibling snapshot"
          ? { entries: [{ name: "same" }, { name: "updated" }] }
          : sourceConfig,
      );
      expect(state.configFormDirty).toBe(transition === "sibling patch");
      expect(onPatch).not.toHaveBeenCalled();
      if (transition === "sibling snapshot") {
        expect(controls()[1]?.value).toBe(
          isJson ? JSON.stringify({ name: "updated" }, null, 2) : "updated",
        );
      }
      expect(refreshed.value).toBe(draft);
      expect(refreshed.validity.valid).toBe(false);
      expect(refreshed.getAttribute("aria-invalid")).toBe("true");
      expect(errorFor(refreshed).hidden).toBe(false);
      expect(errorFor(refreshed).textContent).toBe(refreshed.validationMessage);
    } else {
      expectElement(
        container.querySelector<HTMLButtonElement>("button[aria-label='Remove item']"),
        "first equal row removal",
      ).click();
      const remaining = expectElement(controls()[0], "surviving equal row");
      expect(controls()).toHaveLength(1);
      expect(document.activeElement).toBe(remaining);
      expect(onPatch).toHaveBeenCalledExactlyOnceWith(["entries"], [{ name: "same" }]);
      expect(state.configForm).toEqual({ entries: [{ name: "same" }] });
      expect(state.configFormDirty).toBe(true);
      expect(isJson ? JSON.parse(remaining.value) : remaining.value).toEqual(
        isJson ? { name: "same" } : "same",
      );
      expect(remaining.validity.valid).toBe(true);
      expect(remaining.getAttribute("aria-invalid")).toBe("false");
      expect(errorFor(remaining).hidden).toBe(true);
      expect(errorFor(remaining).textContent).toBe("");
    }
  });
});
