import { afterEach, describe, expect, it } from "vitest";
import {
  applyChatFontSmoothing,
  applyTypefaceOverrides,
  loadTypefaceSpecimens,
  normalizeTypefaceOverride,
  resolveTypefaces,
  syncTypefaceStylesheets,
  TYPEFACES,
} from "./typography.ts";

const fontLinks = () => [
  ...document.querySelectorAll<HTMLLinkElement>('link[id^="openclaw-typeface-"]'),
];
const hrefs = () => fontLinks().map((link) => link.getAttribute("href"));

describe("typeface presentation", () => {
  afterEach(() => {
    for (const link of fontLinks()) {
      link.remove();
    }
    applyTypefaceOverrides();
    applyChatFontSmoothing("system");
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
  ] as const)("loads %s's default faces plus the shared mono face", (theme, [ui, chat]) => {
    const faces = resolveTypefaces(theme);
    expect(faces).toEqual({ ui, chat });
    syncTypefaceStylesheets(faces);
    // The mono face is always declared: base.css --mono promises JetBrains
    // Mono for code spans on every theme; its woff2 still downloads lazily.
    expect(hrefs()).toEqual(
      [...new Set([ui, chat, "jetbrains-mono"])]
        .filter((face) => face !== "system")
        .map((face) => `/fonts/${face}.css`),
    );
  });

  it("loads overrides once, retaining them without fetching for system or custom defaults", () => {
    syncTypefaceStylesheets(resolveTypefaces("dash", "system", "system"));
    expect(hrefs()).toEqual(["/fonts/jetbrains-mono.css"]);
    const faces = resolveTypefaces("dash", "geist", "lora");
    expect(faces).toEqual({ ui: "geist", chat: "lora" });
    syncTypefaceStylesheets(faces);
    expect(hrefs()).toEqual(["/fonts/jetbrains-mono.css", "/fonts/geist.css", "/fonts/lora.css"]);
    expect(resolveTypefaces("custom", "lora")).toEqual({ ui: "lora", chat: "system" });
    const loaded = fontLinks();
    for (const next of [
      faces,
      resolveTypefaces("dash", "geist", "geist"),
      resolveTypefaces("dash", "system", "system"),
      resolveTypefaces("custom", "lora"),
      resolveTypefaces("custom"),
    ]) {
      syncTypefaceStylesheets(next);
      expect(fontLinks()).toEqual(loaded);
    }
  });

  it("reuses active faces when specimens are requested and never duplicates them on switches", () => {
    syncTypefaceStylesheets(resolveTypefaces("dash"));
    const active = fontLinks();
    loadTypefaceSpecimens();
    const specimens = fontLinks();
    expect(specimens).toEqual(expect.arrayContaining(active));
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

  it("opts chat prose into auto smoothing only while the resolved chat face is a serif", () => {
    const style = document.documentElement.style;
    for (const serif of ["lora", "fraunces"] as const) {
      applyChatFontSmoothing(serif);
      expect(style.getPropertyValue("--chat-font-smoothing")).toBe("auto");
    }
    for (const nonSerif of ["instrument-sans", "jetbrains-mono", "system"] as const) {
      applyChatFontSmoothing(nonSerif);
      expect(style.getPropertyValue("--chat-font-smoothing")).toBe("");
    }
  });
});
