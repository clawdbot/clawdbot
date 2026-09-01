import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTitleTooltips } from "./tooltip-title.ts";

// Accessible names and opacity require real layout; keep the canonical browser-only gate.
describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "title tooltip accessible names",
  () => {
    let page: (typeof import("vitest/browser"))["page"];
    let dispose: () => void;

    beforeEach(async () => {
      ({ page } = await import("vitest/browser"));
      dispose = installTitleTooltips(document);
    });

    afterEach(() => {
      dispose();
      document.body.replaceChildren();
    });

    it.each([
      ["pointer", "button"],
      ["pointer", "ancestor"],
      ["focus", "button"],
      ["focus", "ancestor"],
    ] as const)(
      "preserves a text-labelled button after %s enhancement during a %s opacity transition",
      async (input, target) => {
        const container = document.createElement("div");
        const button = document.createElement("button");
        button.textContent = "Edit";
        button.title = "Edit configuration as text";
        const animated = target === "button" ? button : container;
        animated.style.opacity = "0";
        container.append(button);
        document.body.append(container);
        const namedButton = page.getByRole("button", { name: "Edit", exact: true });
        expect(namedButton.elements()).toEqual([button]);
        expect(button.checkVisibility({ checkOpacity: true })).toBe(false);

        if (input === "pointer") {
          await page.elementLocator(button).hover();
        } else {
          button.focus();
        }
        expect(button.title).toBe("");
        animated.style.opacity = "1";
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        expect(button.checkVisibility({ checkOpacity: true })).toBe(true);
        expect(namedButton.elements()).toEqual([button]);
        await namedButton.click();
      },
    );

    it("releases an injected name when an existing text node becomes the label", async () => {
      const button = document.createElement("button");
      const label = document.createTextNode("");
      button.title = "Edit configuration as text";
      button.append(label);
      document.body.append(button);
      await page.elementLocator(button).hover();
      expect(
        page.getByRole("button", { name: "Edit configuration as text", exact: true }).elements(),
      ).toEqual([button]);

      label.data = "Edit";
      await expect
        .poll(() => page.getByRole("button", { name: "Edit", exact: true }).elements())
        .toEqual([button]);
    });

    it.each(["label", "nested subtree"] as const)(
      "updates the active name when aria-hidden changes on the %s",
      async (target) => {
        const button = document.createElement("button");
        const label = document.createElement("span");
        const wrapper = document.createElement("span");
        button.title = "Edit configuration as text";
        label.textContent = "Edit";
        wrapper.append(label);
        button.append(wrapper);
        const hidden = target === "label" ? label : wrapper;
        hidden.setAttribute("aria-hidden", "true");
        document.body.append(button);
        const titleNamedButton = page.getByRole("button", {
          name: "Edit configuration as text",
          exact: true,
        });
        const textNamedButton = page.getByRole("button", { name: "Edit", exact: true });
        await titleNamedButton.hover();
        expect(button.title).toBe("");
        expect(titleNamedButton.elements()).toEqual([button]);

        hidden.setAttribute("aria-hidden", "false");
        await expect.poll(() => textNamedButton.elements()).toEqual([button]);
        await textNamedButton.click();

        hidden.setAttribute("aria-hidden", "true");
        await expect.poll(() => titleNamedButton.elements()).toEqual([button]);
        await titleNamedButton.click();

        await page.elementLocator(button).unhover();
        button.blur();
        expect(button.title).toBe("Edit configuration as text");
        expect(button.hasAttribute("aria-label")).toBe(false);
        expect(titleNamedButton.elements()).toEqual([button]);
      },
    );

    it.each(["hidden", "display", "visibility", "aria-hidden"] as const)(
      "preserves title naming when the only text is %s",
      async (hidden) => {
        const button = document.createElement("button");
        const label = document.createElement("span");
        button.title = "Edit configuration";
        label.textContent = "Decorative text";
        if (hidden === "hidden") {
          label.hidden = true;
        }
        if (hidden === "display") {
          label.style.display = "none";
        }
        if (hidden === "visibility") {
          label.style.visibility = "hidden";
        }
        if (hidden === "aria-hidden") {
          label.setAttribute("aria-hidden", "true");
        }
        button.append(label);
        document.body.append(button);
        const namedButton = page.getByRole("button", { name: "Edit configuration", exact: true });
        expect(namedButton.elements()).toEqual([button]);
        await page.elementLocator(button).hover();
        expect(namedButton.elements()).toEqual([button]);
        await page.elementLocator(button).unhover();
        expect(button.title).toBe("Edit configuration");
        expect(button.hasAttribute("aria-label")).toBe(false);
        expect(namedButton.elements()).toEqual([button]);
      },
    );

    it("preserves an explicit name supplied while the tooltip owns a temporary name", async () => {
      const button = document.createElement("button");
      button.title = "Edit configuration as text";
      document.body.append(button);
      await page.elementLocator(button).hover();
      button.setAttribute("aria-label", "Open editor");
      button.title = "Updated hint";
      await expect.poll(() => button.title).toBe("");
      await page.elementLocator(button).unhover();
      expect(page.getByRole("button", { name: "Open editor", exact: true }).elements()).toEqual([
        button,
      ]);
      expect(button.title).toBe("Updated hint");
    });
  },
);
