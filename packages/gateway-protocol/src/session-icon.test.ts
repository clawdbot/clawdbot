import { describe, expect, it } from "vitest";
import { normalizeSessionIconInput, parseSessionIcon } from "./session-icon.js";

describe("session icons", () => {
  it("parses named and single-grapheme emoji forms", () => {
    expect(parseSessionIcon("name:lobster")).toEqual({ kind: "named", name: "lobster" });
    expect(parseSessionIcon("🦞")).toEqual({ kind: "emoji", emoji: "🦞" });
    expect(parseSessionIcon("👩🏽‍💻")).toEqual({ kind: "emoji", emoji: "👩🏽‍💻" });
    expect(parseSessionIcon("name:Nope")).toBeNull();
    expect(parseSessionIcon("🦞🚀")).toBeNull();
    expect(parseSessionIcon("A")).toBeNull();
  });

  it("trims inputs and canonicalizes safe SVG markup", () => {
    expect(
      normalizeSessionIconInput(
        "  svg:<svg viewBox='0 0 24 24'><g transform='translate(1 2)'><path d='M1 2' fill='currentColor'/></g></svg>  ",
      ),
    ).toEqual({
      ok: true,
      value:
        'svg:<svg viewBox="0 0 24 24"><g transform="translate(1 2)"><path d="M1 2" fill="currentColor"/></g></svg>',
    });
  });

  it.each([
    "svg:<svg><script>alert(1)</script></svg>",
    'svg:<svg onload="alert(1)"></svg>',
    'svg:<svg xmlns:xlink="http://www.w3.org/1999/xlink"><path xlink:href="#x"/></svg>',
    'svg:<svg><path fill="url(#paint)"/></svg>',
    "svg:<!DOCTYPE svg><svg></svg>",
    "svg:<svg></svg><svg></svg>",
    'svg:<svg><use href="#x"/></svg>',
    'svg:<svg><path style="fill:red"/></svg>',
  ])("rejects hostile SVG: %s", (value) => {
    expect(normalizeSessionIconInput(value).ok).toBe(false);
  });

  it("rejects SVG icons over 4096 bytes", () => {
    const value = `svg:<svg><title>${"x".repeat(4096)}</title></svg>`;
    expect(normalizeSessionIconInput(value)).toMatchObject({ ok: false });
  });

  it("rejects SVG whose canonical entity re-encoding exceeds the byte cap", () => {
    // 900 double quotes inside a single-quoted attribute fit the raw cap but
    // reserialize as &quot; (6 bytes each), overflowing the stored form.
    const svg = `svg:<svg viewBox='0 0 16 16'><path d='${'"'.repeat(900)}'/></svg>`;
    expect(new TextEncoder().encode(svg).byteLength).toBeLessThanOrEqual(4096);
    expect(normalizeSessionIconInput(svg).ok).toBe(false);
  });
});
