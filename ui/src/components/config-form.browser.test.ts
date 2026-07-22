// Control UI tests cover config form behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { analyzeConfigSchema, renderConfigForm } from "./config-form.ts";

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

function selectSegmented(control: HTMLElement) {
  const group = expectElement(
    control.closest<HTMLElement & { value: string }>("wa-radio-group"),
    "segmented radio group",
  );
  group.value = control.getAttribute("value") ?? "";
  group.dispatchEvent(new Event("change", { bubbles: true }));
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
        '#config-section-gateway input.settings-input[type="text"]',
      ),
      "gateway token input",
    );
    tokenInput.value = "abc123";
    tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["gateway", "auth", "token"], "abc123");

    const tokenButton = expectElement(
      Array.from(container.querySelectorAll<HTMLElement>(".settings-segmented__btn")).find(
        (btn) => btn.textContent?.trim() === "token",
      ),
      "token segmented button",
    );
    selectSegmented(tokenButton);
    expect(onPatch).toHaveBeenCalledWith(["mode"], "token");

    const checkbox = expectElement(
      container.querySelector<HTMLElement & { checked: boolean }>("wa-switch.settings-toggle"),
      "enabled switch",
    );
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["enabled"], true);

    const addButton = expectElement(
      Array.from(container.querySelectorAll<HTMLButtonElement>(".cfg-array button")).find(
        (btn) => btn.textContent?.trim() === "Add",
      ),
      "array add button",
    );
    addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], ["+1", ""]);

    const removeButton = expectElement(
      container.querySelector(".cfg-array button[aria-label='Remove item']"),
      "array remove button",
    );
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["allowFrom"], []);

    const tailnetButton = expectElement(
      Array.from(container.querySelectorAll<HTMLElement>(".settings-segmented__btn")).find(
        (btn) => btn.textContent?.trim() === "tailnet",
      ),
      "tailnet segmented button",
    );
    selectSegmented(tailnetButton);
    expect(onPatch).toHaveBeenCalledWith(["bind"], "tailnet");
  });

  it("shows phone presentations without changing raw config values", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        fromNumber: { type: "string" },
        target: { type: "string" },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              allowFrom: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    });
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {
          fromNumber: { presentation: "phone-number" },
          target: { presentation: "phone-number" },
          "accounts.*.allowFrom.*": { presentation: "phone-number" },
        },
        unsupportedPaths: analysis.unsupportedPaths,
        value: {
          fromNumber: "+4930123456",
          target: "token-value",
          accounts: { work: { allowFrom: ["+81312345678"] } },
        },
        onPatch,
      }),
      container,
    );

    const phoneInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(".settings-phone-presentation input"),
    );
    expect(phoneInputs.map((input) => input.value)).toEqual(
      expect.arrayContaining(["+4930123456", "+81312345678", "token-value"]),
    );
    expect(phoneInputs).toHaveLength(3);
    expect(
      Array.from(container.querySelectorAll(".settings-phone-presentation__value")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(expect.arrayContaining(["Germany · +49 30 123456", "Japan · +81 3 1234 5678"]));
    const tokenInput = expectElement(
      Array.from(container.querySelectorAll<HTMLInputElement>("input.settings-input")).find(
        (input) => input.value === "token-value",
      ),
      "token input",
    );
    const tokenPresentation = expectElement(
      tokenInput.closest(".settings-phone-presentation"),
      "token phone presentation wrapper",
    );
    expect(tokenPresentation.querySelector(".settings-phone-presentation__value")).toBeNull();

    const fromNumberInput = expectElement(
      phoneInputs.find((input) => input.value === "+4930123456"),
      "from number input",
    );
    fromNumberInput.value = " +4930123456 ";
    fromNumberInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["fromNumber"], " +4930123456 ");
    fromNumberInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["fromNumber"], "+4930123456");
  });

  it("keeps phone inputs focused while presentation appears and disappears", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: { phone: { type: "string" } },
    });
    const renderValue = (phone: string) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: { phone: { presentation: "phone-number" } },
          unsupportedPaths: analysis.unsupportedPaths,
          value: { phone },
          onPatch: vi.fn(),
        }),
        container,
      );
    };

    renderValue("+123");
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input.settings-input"),
      "phone input",
    );
    input.focus();

    renderValue("+4930123456");
    expect(container.querySelector(".settings-phone-presentation__value")?.textContent).toContain(
      "+49 30 123456",
    );
    expect(container.querySelector("input.settings-input")).toBe(input);
    expect(document.activeElement).toBe(input);

    renderValue("+123");
    expect(container.querySelector(".settings-phone-presentation__value")).toBeNull();
    expect(container.querySelector("input.settings-input")).toBe(input);
    expect(document.activeElement).toBe(input);
    container.remove();
  });

  it("renders subsection labels exactly once", () => {
    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: rootAnalysis.schema,
        uiHints: {},
        unsupportedPaths: rootAnalysis.unsupportedPaths,
        value: {},
        activeSection: "gateway",
        activeSubsection: "auth",
        onPatch: vi.fn(),
      }),
      container,
    );

    const headings = Array.from(container.querySelectorAll(".settings-section__heading")).map(
      (node) => node.textContent?.trim(),
    );
    expect(headings).toEqual(["Auth"]);
    // The subsection object emits its fields directly; no nested details block
    // repeats the subsection title inside the group.
    expect(container.querySelector(".cfg-object")).toBeNull();
    const rowTitles = Array.from(container.querySelectorAll(".settings-row__title")).map((node) =>
      node.textContent?.trim(),
    );
    expect(rowTitles).toEqual(["Token"]);
  });

  it("renders boolean fields as named toggle rows", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        features: {
          type: "object",
          properties: {
            beta: { type: "boolean", description: "Enable beta features" },
          },
        },
      },
    });
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: { features: { beta: false } },
        onPatch,
      }),
      container,
    );

    const checkbox = expectElement(
      container.querySelector<HTMLElement & { checked: boolean }>("wa-switch.settings-toggle"),
      "beta switch",
    );
    const row = expectElement(checkbox.closest(".settings-row"), "beta toggle row");
    expect(row.tagName).toBe("DIV");
    expect(row.querySelector(".settings-row__title")?.textContent?.trim()).toBe("Beta");
    expect(row.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
      "Enable beta features",
    );
    expect(checkbox.textContent?.trim()).toBe("Beta");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["features", "beta"], true);
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

    const selects = container.querySelectorAll<HTMLSelectElement>("select.settings-select");
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
      container.querySelector(".cfg-map button[aria-label='Remove entry']"),
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
      Array.from(container.querySelectorAll(".settings-row__title")).find(
        (node) => node.textContent?.trim() === "Plugin Enabled",
      ),
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
      container.querySelector(".settings-section__heading"),
      "tag-filtered section title",
    );
    expect(sectionTitle.textContent?.trim()).toBe("Gateway");
    const fieldLabel = expectElement(
      Array.from(container.querySelectorAll(".settings-row__title")).find(
        (node) => node.textContent?.trim() === "Token",
      ),
      "tag-filtered field label",
    );
    expect(fieldLabel.textContent?.trim()).toBe("Token");
    // Only the Auth subtree (matching the tag filter) renders rows.
    expect(
      Array.from(container.querySelectorAll(".settings-row__title")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Auth", "Token"]);
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
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          "#config-section-models .cfg-map input.settings-input[type='text']",
        ),
      ).find((input) => input.value === "old"),
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

    const typedWithAnyBranchSchema = {
      type: "object",
      properties: {
        lastTouchedAt: {
          title: "Config Last Touched At",
          description: "ISO timestamp of the last config write.",
          anyOf: [{ type: "string" }, {}],
        },
      },
    };
    analysis = analyzeConfigSchema(typedWithAnyBranchSchema);
    expect(analysis.unsupportedPaths).toEqual(["lastTouchedAt"]);

    const nullableSingleBranchSchema = {
      type: "object",
      properties: {
        note: {
          anyOf: [{ type: "string", nullable: true }],
        },
      },
    };
    analysis = analyzeConfigSchema(nullableSingleBranchSchema);
    expect(analysis.unsupportedPaths).toEqual([]);
    expect(analysis.schema?.properties?.note?.nullable).toBe(true);

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

  it("accepts transform-backed public config schema shapes", () => {
    const schema = {
      type: "object",
      properties: {
        lastTouchedAt: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
        setupCommand: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
        },
        chatMessageMaxWidth: {
          type: "string",
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toEqual([]);

    const container = document.createElement("div");
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: {
          lastTouchedAt: "2026-05-05T00:00:00.000Z",
          setupCommand: "apt-get update",
          allowedDomains: ["example.com"],
          chatMessageMaxWidth: "960px",
        },
        onPatch: vi.fn(),
      }),
      container,
    );
    expect(container.textContent).not.toContain("Unsupported schema node");
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
      container.querySelector(".cfg-map button[aria-label='Remove entry']"),
      "accounts remove button",
    );
    removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["accounts"], {});
  });
});
