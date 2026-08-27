// Control UI tests cover per-theme font stylesheet lifecycle.
import { afterEach, describe, expect, it } from "vitest";
import { syncThemeFontStylesheet } from "./theme.ts";

const linkElement = () => document.getElementById("openclaw-theme-fonts");

describe("syncThemeFontStylesheet", () => {
  afterEach(() => {
    linkElement()?.remove();
  });

  it("links each built-in family's own stylesheet", () => {
    for (const theme of [
      "claw",
      "knot",
      "dash",
      "absolutely",
      "tide",
      "beacon",
      "phosphor",
    ] as const) {
      syncThemeFontStylesheet(theme);
      const link = linkElement();
      expect(link).toBeInstanceOf(HTMLLinkElement);
      expect((link as HTMLLinkElement).getAttribute("href")).toBe(`/fonts/${theme}.css`);
    }
  });

  it("reuses the existing link element across switches", () => {
    syncThemeFontStylesheet("claw");
    const first = linkElement();
    syncThemeFontStylesheet("claw");
    expect(linkElement()).toBe(first);
    syncThemeFontStylesheet("dash");
    expect(linkElement()).toBe(first);
    expect((first as HTMLLinkElement).getAttribute("href")).toBe("/fonts/dash.css");
  });

  it("drops the link for a theme without declared faces", () => {
    // An imported custom theme must never keep paying for the previous
    // theme's fonts; the sync removes the stylesheet outright.
    syncThemeFontStylesheet("absolutely");
    expect(linkElement()).not.toBeNull();
    syncThemeFontStylesheet("custom");
    expect(linkElement()).toBeNull();
  });
});
