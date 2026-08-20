import { describe, expect, it } from "vitest";
import { desktopDocumentStyles } from "./desktop-document-styles.ts";

describe("desktop document styles", () => {
  it("uses fixed inset sizing without viewport height units", () => {
    expect(desktopDocumentStyles.cssText).toContain("position: fixed");
    expect(desktopDocumentStyles.cssText).toContain("inset: 0");
    expect(desktopDocumentStyles.cssText).not.toMatch(/\d(?:dvh|svh|lvh|vh)\b/);
  });
});
