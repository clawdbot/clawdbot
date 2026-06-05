// Control UI tests cover theme behavior.
import { describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveSystemTheme, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("resolves named theme families when mode is provided", () => {
    expect(resolveTheme("knot", "dark")).toBe("openknot");
    expect(resolveTheme("dash", "light")).toBe("dash-light");
  });

  it("uses system preference when mode is system", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveTheme("knot", "system")).toBe("openknot-light");
    vi.unstubAllGlobals();
  });
});

describe("resolveSystemTheme", () => {
  it("mirrors the active preferred color scheme", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(resolveSystemTheme()).toBe("light");
    vi.unstubAllGlobals();
  });
});

describe("parseThemeSelection", () => {
  it("maps legacy stored values onto theme + mode", () => {
    expect(parseThemeSelection("system", undefined)).toEqual({
      theme: "claw",
      mode: "system",
    });
    expect(parseThemeSelection("fieldmanual", undefined)).toEqual({
      theme: "dash",
      mode: "dark",
    });
  });
});
