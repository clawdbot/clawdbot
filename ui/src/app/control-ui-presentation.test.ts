/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { applyControlUiPresentation } from "./control-ui-environment-presentation.runtime.ts";
import { applyControlUiAccent } from "./control-ui-presentation.ts";

afterEach(() => {
  applyControlUiAccent();
  applyControlUiPresentation({ environment: null });
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
});

describe("Control UI accent presentation", () => {
  it("prioritizes the user accent and restores operator and theme defaults in order", () => {
    const style = document.documentElement.style;
    applyControlUiPresentation({ environment: null, seamColor: "#123456" });
    expect(style.getPropertyValue("--accent")).toBe("#123456");
    expect(style.getPropertyValue("--primary-foreground")).toBe("#ffffff");

    applyControlUiAccent("#fbbf24");
    expect(style.getPropertyValue("--accent")).toBe("#fbbf24");
    expect(style.getPropertyValue("--primary")).toBe("#fbbf24");
    // Hover must ride the accent too; dark Claw/Knot primary buttons read it.
    expect(style.getPropertyValue("--primary-hover")).toBe(
      "color-mix(in srgb, var(--primary) 82%, white 18%)",
    );
    expect(style.getPropertyValue("--accent-foreground")).toBe("#000000");
    expect(style.getPropertyValue("--primary-foreground")).toBe("#000000");

    applyControlUiAccent();
    expect(style.getPropertyValue("--accent")).toBe("#123456");
    expect(style.getPropertyValue("--primary-foreground")).toBe("#ffffff");

    applyControlUiPresentation({ environment: null });
    for (const property of [
      "--accent",
      "--accent-foreground",
      "--primary-hover",
      "--primary-foreground",
    ]) {
      expect(style.getPropertyValue(property)).toBe("");
    }
  });

  it("keeps the locally restored user accent when operator bootstrap arrives afterward", () => {
    applyControlUiAccent("#6ee7b7");
    applyControlUiPresentation({ environment: null, seamColor: "#123456" });

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#6ee7b7");
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("#000000");
  });

  it.each([
    ["#fbbf24", "#000000"],
    ["#6ee7b7", "#000000"],
    ["#777777", "#000000"],
    ["#747474", "#ffffff"],
    ["#2563eb", "#ffffff"],
  ])("selects readable ink for accent %s", (accent, expectedInk) => {
    applyControlUiAccent(accent);

    expect(document.documentElement.style.getPropertyValue("--accent-foreground")).toBe(
      expectedInk,
    );
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe(
      expectedInk,
    );
  });
});
