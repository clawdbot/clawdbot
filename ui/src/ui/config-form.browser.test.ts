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

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

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

    const tokenInput = expectElement(
      container.querySelector<HTMLInputElement>(
        '#config-section-gateway input.cfg-input[type="text"]',
      ),
      "gateway token input",
    );
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = expectElement(
      Array.from(container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn")).find(
        (btn) => btn.textContent?.trim() === "token",
      ),
      "token segmented button",
    );
    tokenButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox = expectElement(
      container.querySelector<HTMLInputElement>("input[type='checkbox']"),
      "enabled checkbox",
    );
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);

    const addButton = expectElement(container.querySelector(".cfg-array__add"), "array add button");
    addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = expectElement(
      container.querySelector(".cfg-array__item-remove"),
      "array remove button",
    );
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);

    const tailnetButton = expectElement(
      Array.from(container.querySelectorAll<HTMLButtonElement>(".cfg-segmented__btn")).find(
        (btn) => btn.textContent?.trim() === "tailnet",
      ),
      "tailnet segmented button",
    );
    tailnetButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    expect(selectedLabels).toEqual(["tailnet", "openai"]);
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

    const removeButton = expectElement(
      container.querySelector(".cfg-map__item-remove"),
      "map remove button",
    );
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

    const label = expectElement(
      container.querySelector(".cfg-toggle-row__label"),
      "plugin enabled label",
    );
    expect(label.textContent?.trim()).toBe("Plugin Enabled");
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
    expect(tags).toEqual(["security", "secret"]);

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

    const sectionTitle = expectElement(
      container.querySelector(".config-section-card__title"),
      "tag-filtered section title",
    );
    expect(sectionTitle.textContent?.trim()).toBe("Gateway");
    const fieldLabel = expectElement(
      container.querySelector(".cfg-field__label"),
      "tag-filtered field label",
    );
    expect(fieldLabel.textContent?.trim()).toBe("Token");
    expect(
      Array.from(container.querySelectorAll(".cfg-field__label")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Token"]);
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
    expect(analysis.unsupportedPaths).toEqual([]);

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

    const apiKeyInput = expectElement(
      container.querySelector<HTMLInputElement>(
        "#config-section-models .cfg-map__item-value input.cfg-input[type='text']",
      ),
      "provider api key input",
    );
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
    expect(analysis.unsupportedPaths).toEqual([]);

    const nullableSchema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    analysis = analyzeConfigSchema(nullableSchema);
    expect(analysis.unsupportedPaths).toEqual([]);

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
    expect(analysis.unsupportedPaths).toEqual([]);
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
    expect(analysis.unsupportedPaths).toEqual([]);

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

    const removeButton = expectElement(
      container.querySelector(".cfg-map__item-remove"),
      "accounts remove button",
    );
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["accounts"], {});
  });
});
