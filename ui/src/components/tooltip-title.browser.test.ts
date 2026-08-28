import { describe, expect, it } from "vitest";
import { installTitleTooltips } from "./tooltip-title.ts";

// Opacity and accessibility require real layout; the root jsdom lane cannot
// exercise the browser's checkVisibility or accessible-name computation.
describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "title tooltip accessible names",
  () => {
    it.each(["focus", "hover"] as const)(
      "preserves the button name when %s precedes its ancestor becoming opaque",
      async (interaction) => {
        const { page } = await import("vitest/browser");
        const host = document.createElement("div");
        const button = document.createElement("button");
        button.textContent = "Raw";
        button.title = "Edit raw JSON configuration";
        host.style.opacity = "0";
        host.append(button);
        document.body.append(host);
        const byName = page.getByRole("button", { name: "Raw", exact: true });
        expect(byName.elements()).toEqual([button]);
        expect(button.checkVisibility({ checkOpacity: true })).toBe(false);
        const dispose = installTitleTooltips(document);
        try {
          if (interaction === "focus") {
            button.focus();
          } else {
            await byName.hover();
          }
          await document.querySelector("openclaw-tooltip")?.updateComplete;
          host.style.opacity = "1";
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
          expect(button.checkVisibility({ checkOpacity: true })).toBe(true);
          expect(byName.elements()).toEqual([button]);
        } finally {
          dispose();
          host.remove();
        }
      },
    );
  },
);
