import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import { renderConfig } from "./config";

describe("config view", () => {
  it("disables save when form is unsafe", () => {
    const container = document.createElement("div");
    render(
      renderConfig({
        raw: "{\n}\n",
        valid: true,
        issues: [],
        loading: false,
        saving: false,
        connected: true,
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
        onRawChange: vi.fn(),
        onFormModeChange: vi.fn(),
        onFormPatch: vi.fn(),
        onReload: vi.fn(),
        onSave: vi.fn(),
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
});
