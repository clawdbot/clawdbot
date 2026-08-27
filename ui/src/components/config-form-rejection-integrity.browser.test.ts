// Control UI tests cover nested config edit rejection and draft preservation.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { ConfigFormCollectionDraft } from "./config-form-collection-draft.ts";
import { renderArray, renderObject } from "./config-form.node.collection.ts";
import { renderNode } from "./config-form.ts";

type ConfigFormStructuredDraftElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form rejection integrity", () => {
  it("preserves an invalid property draft when a sibling edit rerenders the object", () => {
    const container = document.createElement("div");
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2 },
        mode: { type: "string", enum: ["a", "b", "c", "d", "e", "f"] },
      },
    };
    let currentValue = { name: "valid", mode: "a" };
    const renderValue = () => {
      render(
        renderObject(
          {
            schema,
            value: currentValue,
            path: ["settings"],
            hints: {},
            unsupported: new Set(),
            disabled: false,
            sourceIdentity: currentValue,
            controlIdentity: currentValue,
            onPatch: (path, nextValue) => {
              const key = path.at(-1);
              if (key !== "name" && key !== "mode") {
                return false;
              }
              currentValue = { ...currentValue, [key]: nextValue };
              renderValue();
              return true;
            },
          },
          renderNode,
        ),
        container,
      );
    };

    renderValue();
    const name = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
      "name input",
    );
    name.value = "x";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(name.getAttribute("aria-invalid")).toBe("true");

    const mode = expectElement(
      container.querySelector<HTMLSelectElement>("select[aria-label='Mode']"),
      "mode select",
    );
    mode.value = "1";
    mode.dispatchEvent(new Event("change", { bubbles: true }));

    const rerenderedName = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Name']"),
      "rerendered name input",
    );
    expect(rerenderedName.value).toBe("x");
    expect(rerenderedName.getAttribute("aria-invalid")).toBe("true");
    expect(currentValue).toEqual({ name: "valid", mode: "b" });
  });

  it("keeps a nested collection draft open when its parent rejects the commit", async () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderArray(
        {
          schema: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "array",
              items: { type: "string", pattern: "^[a-z]+$" },
            },
          },
          value: [["alpha"], []],
          path: ["groups"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    const arrays = Array.from(container.querySelectorAll<HTMLElement>(".cfg-array"));
    const secondGroup = expectElement(arrays[2], "second nested array");
    const draft = expectElement(
      secondGroup.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "second nested array draft",
    );
    await draft.updateComplete;
    expectElement(
      Array.from(secondGroup.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add",
      ),
      "second nested array add",
    ).click();
    await draft.updateComplete;
    const value = expectElement(
      draft.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "second nested array draft value",
    );
    value.value = "alpha";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await draft.updateComplete;
    expectElement(
      Array.from(draft.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add",
      ),
      "second nested array commit",
    ).click();
    await draft.updateComplete;

    expect(onPatch).not.toHaveBeenCalled();
    expect(draft.querySelector(".cfg-collection-draft")).not.toBeNull();
    const retainedValue = expectElement(
      draft.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "retained nested array draft value",
    );
    expect(retainedValue.value).toBe("alpha");
    expect(retainedValue.getAttribute("aria-invalid")).toBe("true");
    expect(draft.querySelector<HTMLElement>("[role='alert']")?.hidden).toBe(false);
    container.remove();
  });

  it("opens an array draft when a parent rejects the automatic default", async () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderArray(
        {
          schema: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "array",
              items: { type: "string" },
            },
          },
          value: [[""], []],
          path: ["groups"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    const arrays = Array.from(container.querySelectorAll<HTMLElement>(".cfg-array"));
    const secondGroup = expectElement(arrays[2], "second auto-default array");
    const draft = expectElement(
      secondGroup.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "second auto-default array draft",
    );
    await draft.updateComplete;
    expectElement(
      Array.from(secondGroup.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add",
      ),
      "second auto-default array add",
    ).click();
    await draft.updateComplete;
    expect(draft.querySelector(".cfg-collection-draft")).not.toBeNull();

    const value = expectElement(
      draft.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "array fallback draft value",
    );
    value.value = "x";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await draft.updateComplete;
    expectElement(
      Array.from(draft.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add",
      ),
      "array fallback draft commit",
    ).click();
    expect(onPatch).toHaveBeenCalledWith(["groups"], [[""], ["x"]]);
    container.remove();
  });

  it("opens a map draft when a parent rejects the automatic entry", async () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderArray(
        {
          schema: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "object",
              additionalProperties: { type: "object" },
            },
          },
          value: [{ "custom-1": {} }, {}],
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

    const maps = Array.from(container.querySelectorAll<HTMLElement>(".cfg-map"));
    const secondMap = expectElement(maps[1], "second auto-default map");
    const draft = expectElement(
      secondMap.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "second auto-default map draft",
    );
    await draft.updateComplete;
    expectElement(
      Array.from(secondMap.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
      "second auto-default map add",
    ).click();
    await draft.updateComplete;
    expect(draft.querySelector(".cfg-collection-draft")).not.toBeNull();

    const key = expectElement(
      draft.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
      "map fallback draft key",
    );
    const value = expectElement(
      draft.querySelector<HTMLTextAreaElement>("[data-collection-draft-value]"),
      "map fallback draft value",
    );
    key.value = "custom-2";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    value.value = "{}";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await draft.updateComplete;
    expectElement(
      Array.from(draft.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
      "map fallback draft commit",
    ).click();
    expect(onPatch).toHaveBeenCalledWith(["entries"], [{ "custom-1": {} }, { "custom-2": {} }]);
    container.remove();
  });

  it("restores a map key when a constrained parent rejects the rename", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderArray(
        {
          schema: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          value: [{ a: "1" }, { b: "1" }],
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

    const key = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Key: b']"),
      "second map key",
    );
    key.value = "a";
    key.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(key.value).toBe("b");
  });

  it("blocks renaming a map key whose value is still a redacted secret", () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderObject(
        {
          schema: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          value: { primary: "__OPENCLAW_REDACTED__", plain: "visible" },
          path: ["secrets"],
          hints: {},
          unsupported: new Set(),
          disabled: false,
          onPatch,
        },
        renderNode,
      ),
      container,
    );

    const redactedKey = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Key: primary']"),
      "redacted map key",
    );
    redactedKey.value = "renamed";
    redactedKey.dispatchEvent(new Event("change", { bubbles: true }));

    // Moving the sentinel to a new key can only produce an unsavable draft or,
    // folded with a delete, silently bind the wrong stored credential.
    expect(onPatch).not.toHaveBeenCalled();
    expect(redactedKey.value).toBe("primary");

    const plainKey = expectElement(
      container.querySelector<HTMLInputElement>("input[aria-label='Key: plain']"),
      "plain map key",
    );
    plainKey.value = "renamed";
    plainKey.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["secrets"], {
      primary: "__OPENCLAW_REDACTED__",
      renamed: "visible",
    });
    container.remove();
  });

  it("commits an optional object only after all required children are valid", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let currentValue: Record<string, unknown> = {};
    const onPatch = vi.fn((path: Array<string | number>, value: unknown) => {
      currentValue = { ...currentValue, connection: value };
      renderValue();
      return true;
    });
    const schema = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          required: ["host", "port"],
          properties: {
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1 },
          },
        },
      },
    };
    const renderValue = () => {
      render(
        renderObject(
          {
            schema,
            value: currentValue,
            path: ["settings"],
            hints: {},
            unsupported: new Set(),
            disabled: false,
            onPatch,
          },
          renderNode,
        ),
        container,
      );
    };

    renderValue();
    const draft = expectElement(
      container.querySelector<ConfigFormStructuredDraftElement>(
        "openclaw-config-form-structured-draft",
      ),
      "optional object draft",
    );
    await draft.updateComplete;
    const host = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
      "optional host",
    );
    host.value = "gateway.local";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    await draft.updateComplete;
    expect(onPatch).not.toHaveBeenCalled();

    renderValue();
    await draft.updateComplete;
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
        "preserved optional host",
      ).value,
    ).toBe("gateway.local");

    const port = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "optional port",
    );
    port.value = "18789";
    port.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
      host: "gateway.local",
      port: 18789,
    });
    expect(currentValue).toEqual({
      connection: { host: "gateway.local", port: 18789 },
    });
    expect(container.querySelector("openclaw-config-form-structured-draft")).toBeNull();
    container.remove();
  });

  it("retains a complete optional object draft when its atomic commit is rejected", async () => {
    const onPatch = vi.fn(() => false);
    const container = document.createElement("div");
    document.body.append(container);
    const schema = {
      type: "object",
      properties: {
        connection: {
          type: "object",
          required: ["host", "port"],
          properties: {
            host: { type: "string", minLength: 1 },
            port: { type: "integer", minimum: 1 },
          },
        },
      },
    };
    const renderValue = () => {
      render(
        renderObject(
          {
            schema,
            value: {},
            path: ["settings"],
            hints: {},
            unsupported: new Set(),
            disabled: false,
            onPatch,
          },
          renderNode,
        ),
        container,
      );
    };

    renderValue();
    const draft = expectElement(
      container.querySelector<ConfigFormStructuredDraftElement>(
        "openclaw-config-form-structured-draft",
      ),
      "rejected optional object draft",
    );
    await draft.updateComplete;
    const host = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
      "rejected optional host",
    );
    host.value = "gateway.local";
    host.dispatchEvent(new Event("input", { bubbles: true }));
    await draft.updateComplete;
    const port = expectElement(
      draft.querySelector<HTMLInputElement>("input[aria-label='Port']"),
      "rejected optional port",
    );
    port.value = "18789";
    port.dispatchEvent(new Event("input", { bubbles: true }));
    await draft.updateComplete;

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith(["settings", "connection"], {
      host: "gateway.local",
      port: 18789,
    });
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
        "retained rejected host",
      ).value,
    ).toBe("gateway.local");
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Port']"),
        "retained rejected port",
      ).value,
    ).toBe("18789");
    expect(draft.querySelector<HTMLElement>("[role='alert']")?.textContent).toContain(
      "draft is still here",
    );

    renderValue();
    await draft.updateComplete;
    expect(
      expectElement(
        draft.querySelector<HTMLInputElement>("input[aria-label='Host']"),
        "rerendered rejected host",
      ).value,
    ).toBe("gateway.local");
    expect(draft.querySelector<HTMLElement>("[role='alert']")?.textContent).toContain(
      "draft is still here",
    );
    container.remove();
  });

  it("constructs an optional large-minimum array without leaking partial values", async () => {
    const onPatch = vi.fn((_path: Array<string | number>, _value: unknown) => false);
    const container = document.createElement("div");
    document.body.append(container);
    const schema = {
      type: "object",
      properties: {
        codes: {
          type: "array",
          minItems: 101,
          maxItems: 101,
          items: { type: "string" },
        },
      },
    };
    const renderValue = () => {
      render(
        renderObject(
          {
            schema,
            value: {},
            path: ["settings"],
            hints: {},
            unsupported: new Set(),
            disabled: false,
            onPatch,
          },
          renderNode,
        ),
        container,
      );
    };
    const add = (draft: ConfigFormStructuredDraftElement) =>
      expectElement(
        Array.from(draft.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Add",
        ),
        "large-minimum array add",
      );

    renderValue();
    const draft = expectElement(
      container.querySelector<ConfigFormStructuredDraftElement>(
        "openclaw-config-form-structured-draft",
      ),
      "large-minimum array draft",
    );
    await draft.updateComplete;
    add(draft).click();
    await draft.updateComplete;
    expect(onPatch).not.toHaveBeenCalled();
    expect(draft.textContent).toContain("1 item");

    renderValue();
    await draft.updateComplete;
    expect(draft.textContent).toContain("1 item");

    add(draft).click();
    await draft.updateComplete;
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [path, value] = onPatch.mock.calls[0] ?? [];
    expect(path).toEqual(["settings", "codes"]);
    expect(value).toEqual(Array.from({ length: 101 }, () => ""));
    expect(draft.textContent).toContain("101 items");
    expect(draft.querySelector<HTMLElement>("[role='alert']")?.textContent).toContain(
      "draft is still here",
    );

    renderValue();
    await draft.updateComplete;
    expect(draft.textContent).toContain("101 items");
    expect(draft.querySelector<HTMLElement>("[role='alert']")?.textContent).toContain(
      "draft is still here",
    );
    container.remove();
  });
});
