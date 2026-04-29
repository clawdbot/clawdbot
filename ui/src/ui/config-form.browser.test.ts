import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { analyzeConfigSchema, renderConfigForm } from "./views/config-form.ts";

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
      anyOf: [{ const: "auto" }, { const: "lan" }, { const: "tailnet" }, { const: "loopback" }],
    },
  },
};
const rootAnalysis = analyzeConfigSchema(rootSchema);

describe("config form renderer", () => {
  it("renders inputs and patches values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = rootAnalysis;
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { label: "Gateway Token", sensitive: true },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: { allowFrom: ["+1"], bind: "auto" },
        revealSensitive: true,
        onPatch,
      }),
      container,
    );

    const tokenInput: HTMLInputElement | null = container.querySelector(
      '#config-section-gateway input.cfg-input[type="text"]',
    );
    expect(tokenInput).not.toBeNull();
    if (!tokenInput) {
      return;
    }
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    ).find((btn) => btn.textContent?.trim() === "token");
    expect(tokenButton).not.toBeUndefined();
    tokenButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox: HTMLInputElement | null = container.querySelector("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    if (!checkbox) {
      return;
    }
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);

    const addButton = container.querySelector(".cfg-array__add");
    expect(addButton).not.toBeUndefined();
    addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = container.querySelector(".cfg-array__item-remove");
    expect(removeButton).not.toBeUndefined();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);

    const tailnetButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn"),
    ).find((btn) => btn.textContent?.trim() === "tailnet");
    expect(tailnetButton).not.toBeUndefined();
    tailnetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("keeps dropdown selects on their configured value after options render", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["anthropic", "codex", "gemini", "openai", "openrouter", "zai"],
        },
        bind: {
          anyOf: [
            { const: "auto" },
            { const: "lan" },
            { const: "tailnet" },
            { const: "loopback" },
            { const: "public" },
            { const: "off" },
          ],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { provider: "openai", bind: "tailnet" },
        onPatch,
      }),
      container,
    );

    const selects = container.querySelectorAll<HTMLSelectElement>("select.cfg-select");
    expect(selects).toHaveLength(2);
    const selectedLabels = Array.from(selects).map((select) =>
      select.selectedOptions[0]?.textContent?.trim(),
    );
    expect(selectedLabels).toContain("openai");
    expect(selectedLabels).toContain("tailnet");
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

    const removeButton = container.querySelector(".cfg-map__item-remove");
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

  it("renders tags from uiHints metadata", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = rootAnalysis;
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security", "secret"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        onPatch,
      }),
      container,
    );

    const tags = Array.from(container.querySelectorAll(".cfg-tag")).map((node) =>
      node.textContent?.trim(),
    );
    expect(tags).toContain("security");
    expect(tags).toContain("secret");

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "gateway.auth.token": { tags: ["security"] },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {},
        searchQuery: "tag:security",
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain("Gateway");
    expect(container.textContent).toContain("Token");
    expect(container.textContent).not.toContain("Allow From");
    expect(container.textContent).not.toContain("Mode");
  });

  it("supports SecretInput unions in additionalProperties maps", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        models: {
          type: "object",
          properties: {
            providers: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  apiKey: {
                    anyOf: [
                      { type: "string" },
                      {
                        oneOf: [
                          {
                            type: "object",
                            properties: {
                              source: { type: "string", const: "env" },
                              provider: { type: "string" },
                              id: { type: "string" },
                            },
                            required: ["source", "provider", "id"],
                            additionalProperties: false,
                          },
                          {
                            type: "object",
                            properties: {
                              source: { type: "string", const: "file" },
                              provider: { type: "string" },
                              id: { type: "string" },
                            },
                            required: ["source", "provider", "id"],
                            additionalProperties: false,
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("models.providers");
    expect(analysis.unsupportedPaths).not.toContain("models.providers.*.apiKey");

    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          "models.providers.*.apiKey": { sensitive: true },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: { models: { providers: { openai: { apiKey: "old" } } } }, // pragma: allowlist secret
        revealSensitive: true,
        onPatch,
      }),
      container,
    );

    const apiKeyInput: HTMLInputElement | null = container.querySelector(
      "#config-section-models .cfg-map__item-value input.cfg-input[type='text']",
    );
    expect(apiKeyInput).not.toBeNull();
    if (!apiKeyInput) {
      return;
    }
    apiKeyInput.value = "new-key";
    apiKeyInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["models", "providers", "openai", "apiKey"], "new-key");
  });

  it("accepts renderable unions", () => {
    const renderableUnionSchema = {
      type: "object",
      properties: {
        mixed: {
          anyOf: [{ type: "string" }, { type: "object", properties: {} }],
        },
      },
    };
    let analysis = analyzeConfigSchema(renderableUnionSchema);
    expect(analysis.unsupportedPaths).not.toContain("mixed");

    const nullableSchema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    analysis = analyzeConfigSchema(nullableSchema);
    expect(analysis.unsupportedPaths).not.toContain("note");

    const untypedAdditionalPropertiesSchema = {
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
    analysis = analyzeConfigSchema(untypedAdditionalPropertiesSchema);
    expect(analysis.unsupportedPaths).not.toContain("channels");
  });

  it("treats additionalProperties true as editable map fields", () => {
    const schema = {
      type: "object",
      properties: {
        accounts: {
          type: "object",
          additionalProperties: true,
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("accounts");

    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { accounts: { default: { enabled: true } } },
        onPatch,
      }),
      container,
    );

    const removeButton = container.querySelector(".cfg-map__item-remove");
    expect(removeButton).not.toBeNull();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["accounts"], {});
  });
});
