import { afterEach, describe, expect, it } from "vitest";
import {
  applyTypefaceOverrides,
  loadTypefaceSpecimens,
  normalizeTypefaceOverride,
  resolveTypefaces,
  syncTypefaceStylesheets,
  TYPEFACES,
} from "./typography.ts";

const fontLinks = () => [
  ...document.querySelectorAll<HTMLLinkElement>(
    'link[id^="openclaw-font-"], link[id^="openclaw-typeface-"]',
  ),
];
const hrefs = () => fontLinks().map((link) => link.getAttribute("href"));

describe("typeface presentation", () => {
  afterEach(() => {
    for (const link of fontLinks()) {
      link.remove();
    }
    applyTypefaceOverrides();
  });

  it.each([
    ["claw", ["instrument-sans", "instrument-sans"]],
    ["knot", ["geist", "geist"]],
    ["dash", ["dm-sans", "fraunces"]],
    ["absolutely", ["space-grotesk", "lora"]],
    ["tide", ["ibm-plex-sans", "ibm-plex-sans"]],
    ["beacon", ["atkinson-hyperlegible", "atkinson-hyperlegible"]],
    ["phosphor", ["jetbrains-mono", "jetbrains-mono"]],
    ["custom", ["system", "system"]],
  ] as const)("loads only %s's default faces", (theme, [ui, chat]) => {
    const faces = resolveTypefaces(theme);
    expect(faces).toEqual({ ui, chat });
    syncTypefaceStylesheets(faces);
    expect(hrefs()).toEqual(
      [...new Set([ui, chat])]
        .filter((face) => face !== "system")
        .map((face) => `/fonts/${face}.css`),
    );
  });

  it("lets overrides win, reuses slots, and removes duplicate or system faces", () => {
    syncTypefaceStylesheets(resolveTypefaces("dash"));
    const first = fontLinks()[0];
    const faces = resolveTypefaces("dash", "geist", "lora");
    expect(faces).toEqual({ ui: "geist", chat: "lora" });
    syncTypefaceStylesheets(faces);
    expect(fontLinks()[0]).toBe(first);
    expect(hrefs()).toEqual(["/fonts/geist.css", "/fonts/lora.css"]);
    syncTypefaceStylesheets(resolveTypefaces("dash", "geist", "geist"));
    expect(hrefs()).toEqual(["/fonts/geist.css"]);
    syncTypefaceStylesheets(resolveTypefaces("dash", "system", "system"));
    expect(hrefs()).toEqual([]);
    syncTypefaceStylesheets(resolveTypefaces("custom", "lora"));
    expect(hrefs()).toEqual(["/fonts/lora.css"]);
    syncTypefaceStylesheets(resolveTypefaces("custom"));
    expect(hrefs()).toEqual([]);
  });

  it("reuses active faces when specimens are requested and never duplicates them on switches", () => {
    syncTypefaceStylesheets(resolveTypefaces("dash"));
    const active = fontLinks()[0];
    expect(fontLinks()).toHaveLength(2);
    loadTypefaceSpecimens();
    const specimens = fontLinks();
    expect(specimens).toContain(active);
    expect(specimens).toHaveLength(9);
    expect(new Set(hrefs()).size).toBe(9);
    loadTypefaceSpecimens();
    syncTypefaceStylesheets(resolveTypefaces("knot", "lora"));
    expect(fontLinks()).toEqual(specimens);
  });

  it("removes inline overrides to return ownership to theme CSS without changing code", () => {
    const style = document.documentElement.style;
    const mono = style.getPropertyValue("--mono");
    applyTypefaceOverrides("lora", "system");
    expect(style.getPropertyValue("--font-body")).toBe(TYPEFACES.lora.stack);
    expect(style.getPropertyValue("--font-chat")).toBe(TYPEFACES.system.stack);
    applyTypefaceOverrides();
    expect(style.getPropertyValue("--font-body")).toBe("");
    expect(style.getPropertyValue("--font-chat")).toBe("");
    expect(style.getPropertyValue("--mono")).toBe(mono);
  });

  it.each(["theme", "unknown", "Lora", "serif; color: red", null, {}, 42])(
    "ignores invalid override %j",
    (value) => {
      expect(normalizeTypefaceOverride(value)).toBeUndefined();
    },
  );
});
