import { describe, expect, it } from "vitest";
import type { ThemeMode } from "../app/theme.ts";
import type { ThemeModeChangeDetail } from "./theme-mode-toggle.ts";
import "./theme-mode-toggle.ts";

type ThemeModeToggleElement = HTMLElement & {
  mode: ThemeMode;
  updateComplete: Promise<boolean>;
};

describe("theme mode toggle", () => {
  it("defaults to system and cycles one button through every mode", async () => {
    const toggle = document.createElement("openclaw-theme-mode-toggle") as ThemeModeToggleElement;
    const modes: ThemeMode[] = [];
    toggle.addEventListener("theme-change", ((event: CustomEvent<ThemeModeChangeDetail>) => {
      modes.push(event.detail.mode);
      toggle.mode = event.detail.mode;
    }) as EventListener);
    document.body.append(toggle);

    try {
      await toggle.updateComplete;
      expect(toggle.mode).toBe("system");
      expect(toggle.querySelectorAll("button")).toHaveLength(1);
      expect(toggle.querySelector("button")?.getAttribute("aria-label")).toBe("Color mode: System");

      for (const expected of ["light", "dark", "system"] satisfies ThemeMode[]) {
        toggle.querySelector<HTMLButtonElement>("button")?.click();
        await toggle.updateComplete;
        expect(toggle.mode).toBe(expected);
        expect(toggle.querySelectorAll("button")).toHaveLength(1);
      }

      expect(modes).toEqual(["light", "dark", "system"]);
      expect(toggle.querySelector("button")?.getAttribute("aria-label")).toBe("Color mode: System");
    } finally {
      toggle.remove();
    }
  });
});
