// @vitest-environment node
// Control UI tests cover theme behavior.
import { describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveTheme, type ThemeName } from "./theme.ts";

describe("resolveTheme", () => {
  it.each([
    ["claw", "dark", "light"],
    ["knot", "openknot", "openknot-light"],
    ["dash", "dash", "dash-light"],
    ["absolutely", "absolutely", "absolutely-light"],
    ["tide", "tide", "tide-light"],
    ["beacon", "beacon", "beacon-light"],
    ["phosphor", "phosphor", "phosphor-light"],
    ["crt", "crt", "crt-light"],
    ["manuscript", "manuscript", "manuscript-light"],
    ["rose", "rose", "rose-light"],
    ["miami", "miami", "miami-light"],
    ["custom", "custom", "custom-light"],
  ] satisfies [ThemeName, string, string][])(
    "resolves %s in both explicit modes",
    (theme, dark, light) => {
      expect(resolveTheme(theme, "dark")).toBe(dark);
      expect(resolveTheme(theme, "light")).toBe(light);
    },
  );

  it("uses system preference when mode is system", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("knot", "system")).toBe("openknot-light");
    vi.unstubAllGlobals();
  });
});

describe("parseThemeSelection", () => {
  it("falls back to defaults for unknown stored values", () => {
    expect(parseThemeSelection("fieldmanual", "invalid-mode")).toEqual({
      theme: "claw",
      mode: "system",
    });
    expect(parseThemeSelection("dash", "light")).toEqual({
      theme: "dash",
      mode: "light",
    });
  });
});
