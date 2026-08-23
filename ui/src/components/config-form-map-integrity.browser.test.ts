import { render } from "lit";
import { describe, expect, it } from "vitest";
import { ConfigFormCollectionDraft } from "./config-form-collection-draft.ts";
import { analyzeConfigSchema, renderConfigForm } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form map integrity", () => {
  it("retains unset map drafts until the collection source changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        aliases: {
          type: "object",
          additionalProperties: {
            type: "string",
            pattern: "^[0-9]+$",
          },
        },
      },
    });
    const renderValue = (aliases: Record<string, unknown> | undefined) => {
      render(
        renderConfigForm({
          schema: analysis.schema,
          uiHints: {},
          unsupportedPaths: analysis.unsupportedPaths,
          value: aliases === undefined ? {} : { aliases },
          showAdvanced: true,
          onShowAdvanced: () => {},
          onPatch: () => {},
        }),
        container,
      );
    };

    renderValue(undefined);
    const map = expectElement(container.querySelector<HTMLElement>(".cfg-map"), "unset map");
    const draftHost = expectElement(
      map.querySelector<ConfigFormCollectionDraft>("openclaw-config-form-collection-draft"),
      "unset map draft host",
    );
    expectElement(
      Array.from(map.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Add Entry",
      ),
      "unset map add button",
    ).click();
    await draftHost.updateComplete;
    const key = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
      "unset map draft key",
    );
    const value = expectElement(
      draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
      "unset map draft value",
    );
    key.value = "primary";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    value.value = "123";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await draftHost.updateComplete;

    renderValue(undefined);
    await draftHost.updateComplete;
    expect(
      expectElement(
        draftHost.querySelector<HTMLInputElement>("[data-collection-draft-key]"),
        "preserved unset map draft key",
      ).value,
    ).toBe("primary");
    expect(
      expectElement(
        draftHost.querySelector<HTMLInputElement>("[data-collection-draft-value]"),
        "preserved unset map draft value",
      ).value,
    ).toBe("123");

    renderValue({});
    await draftHost.updateComplete;
    expect(draftHost.querySelector(".cfg-collection-draft")).toBeNull();
    container.remove();
  });
});
