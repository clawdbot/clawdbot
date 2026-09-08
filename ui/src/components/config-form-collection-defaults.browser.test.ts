// Control UI tests cover collection default provenance and editing behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderArray, renderObject } from "./config-form.node.collection.ts";
import { renderJsonTextarea } from "./config-form.node.json.ts";
import { renderNode } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form collection defaults", () => {
  it("shows and clears optional JSON defaults without authoring the inherited value", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      anyOf: [{ type: "object" as const }, { type: "array" as const }],
      default: { mode: "balanced" },
    };

    render(
      renderJsonTextarea({
        schema,
        value: { mode: "custom" },
        path: ["payload"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain('Default: {"mode":"balanced"}');
    const textarea = expectElement(
      container.querySelector<HTMLTextAreaElement>("textarea"),
      "explicit JSON",
    );
    expect(textarea.value).toBe('{\n  "mode": "custom"\n}');
    textarea.value = "";
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["payload"], undefined);

    onPatch.mockClear();
    render(
      renderJsonTextarea({
        schema,
        value: undefined,
        path: ["payload"],
        hints: {},
        unsupported: new Set(),
        disabled: false,
        onPatch,
      }),
      container,
    );

    expect(container.textContent).toContain('Using default: {"mode":"balanced"}');
    expect(
      expectElement(container.querySelector<HTMLTextAreaElement>("textarea"), "inherited JSON")
        .value,
    ).toBe('{\n  "mode": "balanced"\n}');
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("shows optional array defaults and authors inherited items without dropping siblings", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn(() => false);
    const schema = {
      type: "array" as const,
      items: { type: "string" as const },
      default: ["a", "b"],
    };

    render(
      renderArray(
        {
          schema,
          value: ["custom"],
          path: ["values"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).toContain('Default: ["a","b"]');
    expect(container.textContent).toContain("1 item");
    expect(
      expectElement(container.querySelector<HTMLInputElement>("input"), "explicit array item")
        .value,
    ).toBe("custom");

    onPatch.mockClear();
    render(
      renderArray(
        {
          schema,
          value: undefined,
          path: ["values"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).toContain('Using default: ["a","b"]');
    expect(container.textContent).toContain("2 items");
    const inheritedInputs = Array.from(container.querySelectorAll<HTMLInputElement>("input"));
    expect(inheritedInputs.map((input) => input.value)).toEqual(["", ""]);
    expect(inheritedInputs.map((input) => input.placeholder)).toEqual(["Default: a", "Default: b"]);
    expect(onPatch).not.toHaveBeenCalled();

    inheritedInputs[1]!.value = "custom";
    inheritedInputs[1]!.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(onPatch).toHaveBeenCalledWith(["values"], ["a", "custom"]);
  });

  it("authors a nested inherited array item without dropping sibling defaults", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      type: "array" as const,
      default: [
        { name: "alpha", details: { label: "one", note: "keep-one" } },
        { name: "beta", details: { label: "two", note: "keep-two" } },
      ],
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, title: "Name" },
          details: {
            type: "object" as const,
            title: "Details",
            properties: {
              label: { type: "string" as const, title: "Label" },
              note: { type: "string" as const, title: "Note" },
            },
          },
        },
      },
    };

    render(
      renderArray(
        {
          schema,
          value: undefined,
          path: ["entries"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    const labels = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[aria-label='Label']"),
    );
    expect(labels).toHaveLength(2);
    labels[0]!.value = "changed";
    labels[0]!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledExactlyOnceWith(
      ["entries"],
      [
        { name: "alpha", details: { label: "changed", note: "keep-one" } },
        { name: "beta", details: { label: "two", note: "keep-two" } },
      ],
    );
  });

  it("conceals sensitive collection defaults", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const hints = {
      "settings.profile": { sensitive: true },
      "settings.tokens": { sensitive: true },
    };

    render(
      renderObject(
        {
          schema: {
            type: "object",
            title: "Profile",
            default: { apiKey: "default-secret" },
            properties: { apiKey: { type: "string" } },
          },
          value: { apiKey: "authored-secret" },
          path: ["settings", "profile"],
          hints,
          unsupported: new Set(),
          disabled: false,
          revealSensitive: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).not.toContain("default-secret");

    render(
      renderArray(
        {
          schema: {
            type: "array",
            title: "Tokens",
            items: { type: "string" },
            default: ["default-token"],
          },
          value: ["authored-token"],
          path: ["settings", "tokens"],
          hints,
          unsupported: new Set(),
          disabled: false,
          revealSensitive: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).not.toContain("default-token");
  });

  it("shows a top-level object default without nesting the section", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();
    const schema = {
      type: "object" as const,
      title: "Settings",
      default: { mode: "balanced" },
      properties: {
        mode: { type: "string" as const, title: "Mode" },
      },
    };

    render(
      renderObject(
        {
          schema,
          value: { mode: "custom" },
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
          onRemove,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).toContain('Default: {"mode":"balanced"}');
    expect(container.querySelector("details")).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();

    onPatch.mockClear();
    onRemove.mockClear();
    render(
      renderObject(
        {
          schema,
          value: undefined,
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
          onRemove,
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).toContain('Using default: {"mode":"balanced"}');
    expect(container.querySelector("details")).toBeNull();
    expect(
      expectElement(container.querySelector<HTMLInputElement>("input"), "inherited mode")
        .placeholder,
    ).toBe("Default: balanced");
    expect(onPatch).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("conceals a sensitive top-level object default", () => {
    const container = document.createElement("div");

    render(
      renderObject(
        {
          schema: {
            type: "object",
            title: "Settings",
            default: { apiKey: "default-secret" },
            properties: { apiKey: { type: "string" } },
          },
          value: { apiKey: "authored-secret" },
          path: ["settings"],
          hints: { settings: { sensitive: true } },
          unsupported: new Set(),
          disabled: false,
          revealSensitive: false,
          onPatch: vi.fn(),
        },
        renderNode,
      ),
      container,
    );

    expect(container.textContent).not.toContain("default-secret");
    expect(container.querySelector("details")).toBeNull();
  });

  it("keeps optional object children inherited until edited", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();
    const schema = {
      type: "object" as const,
      properties: {
        profile: {
          type: "object" as const,
          title: "Profile",
          default: { enabled: true, mode: "balanced" },
          properties: {
            enabled: { type: "boolean" as const, title: "Enabled" },
            mode: { type: "string" as const, title: "Mode" },
          },
        },
        sibling: { type: "string" as const, title: "Sibling" },
      },
    };

    render(
      renderObject(
        {
          schema,
          value: {
            profile: { enabled: false, mode: "custom" },
            sibling: "preserved",
          },
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
          onRemove,
        },
        renderNode,
      ),
      container,
    );

    const profile = expectElement(
      Array.from(container.querySelectorAll("details")).find((details) =>
        details.textContent?.includes("Profile"),
      ),
      "explicit profile object",
    );
    expect(profile.textContent).toContain('Default: {"enabled":true,"mode":"balanced"}');
    expect(onPatch).not.toHaveBeenCalled();

    onRemove.mockClear();
    render(
      renderObject(
        {
          schema,
          value: { sibling: "preserved" },
          path: ["settings"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
          onRemove,
        },
        renderNode,
      ),
      container,
    );

    const inheritedProfile = expectElement(
      Array.from(container.querySelectorAll("details")).find((details) =>
        details.textContent?.includes("Profile"),
      ),
      "inherited profile object",
    );
    expect(inheritedProfile.textContent).toContain(
      'Using default: {"enabled":true,"mode":"balanced"}',
    );
    const enabledRow = expectElement(
      Array.from(inheritedProfile.querySelectorAll(".settings-row")).find((row) =>
        row.textContent?.includes("Enabled"),
      ),
      "inherited enabled row",
    );
    const modeRow = expectElement(
      Array.from(inheritedProfile.querySelectorAll(".settings-row")).find((row) =>
        row.textContent?.includes("Mode"),
      ),
      "inherited mode row",
    );
    expect(enabledRow.textContent).toContain("Using default: true");
    expect(modeRow.textContent).toContain("Using default: balanced");
    expect(
      expectElement(modeRow.querySelector<HTMLInputElement>("input"), "inherited mode input")
        .placeholder,
    ).toBe("Default: balanced");
    expect(onRemove).not.toHaveBeenCalled();

    const modeInput = expectElement(
      modeRow.querySelector<HTMLInputElement>("input"),
      "inherited mode input",
    );
    modeInput.value = "custom";
    modeInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    expect(onPatch).toHaveBeenCalledWith(["settings", "profile"], {
      enabled: true,
      mode: "custom",
    });
  });
});
