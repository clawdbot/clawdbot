import { describe, expect, it } from "vitest";
import { findRawWindowOpenLines } from "../../scripts/check-no-raw-window-open.mjs";

describe("check-no-raw-window-open", () => {
  it("finds direct window.open calls", () => {
    const source = `
      function openDocs() {
        window.open("https://docs.openclaw.ai");
      }
    `;
    expect(findRawWindowOpenLines(source)).toEqual([3]);
  });

  it("finds globalThis.open calls", () => {
    const source = `
      function openDocs() {
        globalThis.open("https://docs.openclaw.ai");
      }
    `;
    expect(findRawWindowOpenLines(source)).toEqual([3]);
  });

  it("ignores mentions in strings and comments", () => {
    const source = `
      // window.open("https://example.com")
      const text = "window.open('https://example.com')";
    `;
    expect(findRawWindowOpenLines(source)).toStrictEqual([]);
  });

  it("handles parenthesized and asserted window references", () => {
    const source = `
      const openRef = (window as Window).open;
      openRef("https://example.com");
      (window as Window).open("https://example.com");
    `;
    expect(findRawWindowOpenLines(source)).toEqual([4]);
  });
});
