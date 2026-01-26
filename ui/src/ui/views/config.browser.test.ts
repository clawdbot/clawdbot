import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import { renderConfig } from "./config";

describe("config view", () => {
  const baseProps = () => ({
    raw: "{\n}\n",
    originalRaw: "{\n}\n",
    valid: true,
    issues: [],
    loading: false,
    saving: false,
    applying: false,
    updating: false,
    connected: true,
    schema: {
      type: "object",
      properties: {},
    },
    schemaLoading: false,
    uiHints: {},
    formMode: "form" as const,
    formValue: {},
    originalValue: {},
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onReload: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onSubsectionChange: vi.fn(),
  });

  it("allows save when form is unsafe", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: {
          type: "object",
          properties: {
            mixed: {
              anyOf: [{ type: "string" }, { type: "object", properties: {} }],
            },
          },
        },
        schemaLoading: false,
        uiHints: {},
        formMode: "form",
        formValue: { mixed: "x" },
      }),
      container,
    );

    const saveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Save") as
      | HTMLButtonElement
      | undefined;
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
  });

  it("disables save when schema is missing", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        schema: null,
        formMode: "form",
        formValue: { gateway: { mode: "local" } },
        originalValue: {},
      }),
      container,
    );

    const saveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Save") as
      | HTMLButtonElement
      | undefined;
    expect(saveButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
  });

  it("disables save and apply when raw is unchanged", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        raw: "{\n}\n",
        originalRaw: "{\n}\n",
      }),
      container,
    );

    const saveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Save") as
      | HTMLButtonElement
      | undefined;
    const applyButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Apply") as
      | HTMLButtonElement
      | undefined;
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(true);
    expect(applyButton?.disabled).toBe(true);
  });

  it("enables save and apply when raw changes", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        ...baseProps(),
        formMode: "raw",
        raw: "{\n  gateway: { mode: \"local\" }\n}\n",
        originalRaw: "{\n}\n",
      }),
      container,
    );

    const saveButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Save") as
      | HTMLButtonElement
      | undefined;
    const applyButton = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Apply") as
      | HTMLButtonElement
      | undefined;
    expect(saveButton).not.toBeUndefined();
    expect(applyButton).not.toBeUndefined();
    expect(saveButton?.disabled).toBe(false);
    expect(applyButton?.disabled).toBe(false);
  });

  it("switches mode via the sidebar toggle", () => {
    const container = document.createElement("div");
    const onFormModeChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onFormModeChange,
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Raw",
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    btn?.click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("switches sections from the sidebar", () => {
    const container = document.createElement("div");
    const onSectionChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSectionChange,
        schema: {
          type: "object",
          properties: {
            gateway: { type: "object", properties: {} },
            agents: { type: "object", properties: {} },
          },
        },
      }),
      container,
    );

    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Gateway",
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    btn?.click();
    expect(onSectionChange).toHaveBeenCalledWith("gateway");
  });

  it("wires search input to onSearchChange", () => {
    const container = document.createElement("div");
    const onSearchChange = vi.fn();
    render(
      renderConfig({
        ...baseProps(),
        onSearchChange,
      }),
      container,
    );

    const input = container.querySelector(
      ".config-search__input",
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (!input) return;
    input.value = "gateway";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSearchChange).toHaveBeenCalledWith("gateway");
  });
});
