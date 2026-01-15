import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import { analyzeConfigSchema, renderConfigForm } from "./views/config-form";

const rootSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    allowFrom: {
      type: "array",
      items: { type: "string" },
    },
    mode: {
      type: "string",
      enum: ["off", "token"],
    },
    enabled: {
      type: "boolean",
    },
    bind: {
      anyOf: [
        { const: "auto" },
        { const: "lan" },
        { const: "tailnet" },
        { const: "loopback" },
      ],
    },
  },
};

describe("config form renderer", () => {
  it("renders inputs and patches values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { label: "Gateway Token", sensitive: true },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        onPatch,
      }),
      container,
    );

    const tokenInput = container.querySelector(
      "input[type='password']",
    ) as HTMLInputElement | null;
    expect(tokenInput).not.toBeNull();
    if (!tokenInput) return;
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(
      ["gateway", "auth", "token"],
      "abc123",
    );

    const select = container.querySelector("select") as HTMLSelectElement | null;
    const selects = Array.from(container.querySelectorAll("select"));
    const modeSelect = selects.find((el) =>
      Array.from(el.options).some((opt) => opt.textContent?.trim() === "token"),
    ) as HTMLSelectElement | undefined;
    expect(modeSelect).not.toBeUndefined();
    if (!modeSelect) return;
    const tokenOption = Array.from(modeSelect.options).find(
      (opt) => opt.textContent?.trim() === "token",
    );
    expect(tokenOption).not.toBeUndefined();
    if (!tokenOption) return;
    modeSelect.value = tokenOption.value;
    modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox = container.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    if (!checkbox) return;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);
  });

  it("adds and removes array entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { allowFrom: ["+1"] },
        onPatch,
      }),
      container,
    );

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Add",
    );
    expect(addButton).not.toBeUndefined();
    addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Remove",
    );
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);
  });

  it("renders union literals as select options", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(rootSchema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { bind: "auto" },
        onPatch,
      }),
      container,
    );

    const selects = Array.from(container.querySelectorAll("select"));
    const bindSelect = selects.find((el) =>
      Array.from(el.options).some((opt) => opt.textContent?.trim() === "tailnet"),
    ) as HTMLSelectElement | undefined;
    expect(bindSelect).not.toBeUndefined();
    if (!bindSelect) return;
    const tailnetOption = Array.from(bindSelect.options).find(
      (opt) => opt.textContent?.trim() === "tailnet",
    );
    expect(tailnetOption).not.toBeUndefined();
    if (!tailnetOption) return;
    bindSelect.value = tailnetOption.value;
    bindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("renders map fields from additionalProperties", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        slack: {
          type: "object",
          additionalProperties: {
            type: "string",
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { slack: { channelA: "ok" } },
        onPatch,
      }),
      container,
    );

    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "Remove",
    );
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["slack"], {});
  });

  it("supports wildcard uiHints for map entries", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          properties: {
            entries: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "plugins.entries.*.enabled": { label: "Plugin Enabled" },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: { plugins: { entries: { "voice-call": { enabled: true } } } },
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Plugin Enabled");
  });

  it("flags unsupported unions", () => {
    const schema = {
      type: "object",
      properties: {
        mixed: {
          anyOf: [{ type: "string" }, { type: "object", properties: {} }],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toContain("mixed");
  });

  it("supports nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("note");
  });

  it("ignores untyped additionalProperties schemas", () => {
    const schema = {
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                enabled: { type: "boolean" },
              },
            },
          },
          additionalProperties: {},
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("channels");
  });

  it("flags additionalProperties true", () => {
    const schema = {
      type: "object",
      properties: {
        extra: {
          type: "object",
          additionalProperties: true,
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toContain("extra");
  });
});
