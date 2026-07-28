// @vitest-environment jsdom
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import { createConfigViewState, renderConfig, type ConfigProps } from "./view.ts";

function baseProps(): ConfigProps {
  return {
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
      properties: {
        gateway: {
          type: "object",
          properties: {
            mode: { type: "string" },
          },
        },
      },
    },
    schemaLoading: false,
    uiHints: {},
    formMode: "form",
    viewState: createConfigViewState(),
    showModeToggle: true,
    formValue: { gateway: { mode: "remote" } },
    originalValue: { gateway: { mode: "local" } },
    searchQuery: "",
    activeSection: null,
    activeSubsection: null,
    onRawChange: vi.fn(),
    onFormModeChange: vi.fn(),
    onViewStateChange: vi.fn(),
    onFormPatch: vi.fn(),
    onSearchChange: vi.fn(),
    onSectionChange: vi.fn(),
    onSubsectionChange: vi.fn(),
    onReload: vi.fn(),
    onReset: vi.fn(),
    onSave: vi.fn(),
    onApply: vi.fn(),
    onUpdate: vi.fn(),
    onOpenFile: vi.fn(),
    version: "2026.3.11",
    theme: "claw" as ThemeName,
    themeMode: "system" as ThemeMode,
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    hasCustomTheme: false,
    customThemeLabel: null,
    customThemeSourceUrl: null,
    customThemeImportUrl: "",
    customThemeImportBusy: false,
    customThemeImportMessage: null,
    onCustomThemeImportUrlChange: vi.fn(),
    onImportCustomTheme: vi.fn(),
    onClearCustomTheme: vi.fn(),
    borderRadius: 50,
    setBorderRadius: vi.fn(),
    textScale: 100,
    setTextScale: vi.fn(),
    gatewayUrl: "",
    assistantName: "OpenClaw",
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button as HTMLButtonElement;
}

function requireElement<T extends Element>(
  container: HTMLElement,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector(selector);
  expect(element).toBeInstanceOf(constructor);
  return element as T;
}

describe("config view host policy", () => {
  it("greys out editable config controls when the host marks settings read-only", () => {
    const container = document.createElement("div");
    const renderCase = (overrides: Partial<ConfigProps>) =>
      render(renderConfig({ ...baseProps(), ...overrides }), container);

    renderCase({ readOnly: true });

    expect(buttonByText(container, "Save").disabled).toBe(true);
    expect(buttonByText(container, "Apply").disabled).toBe(true);
    expect(buttonByText(container, "Open").disabled).toBe(true);
    expect(requireElement(container, ".cfg-input", HTMLInputElement).disabled).toBe(true);
    expect(container.querySelector(".config-layout--host-readonly")).toBeInstanceOf(HTMLElement);

    renderCase({
      readOnly: true,
      formMode: "raw",
      raw: '{\n  "gateway": { "mode": "remote" }\n}\n',
      originalRaw: "{\n}\n",
    });

    expect(buttonByText(container, "Save").disabled).toBe(true);
    expect(buttonByText(container, "Apply").disabled).toBe(true);
    expect(
      requireElement(container, ".config-raw-field textarea", HTMLTextAreaElement).disabled,
    ).toBe(true);
  });
});
