/**
 * Shared bash-tool helper tests.
 * Covers strict env parsing and compact session labels.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkString, deriveSessionName, readEnvInt } from "./bash-tools.shared.js";

describe("readEnvInt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads deprecated PI env integer aliases behind OPENCLAW env names", () => {
    vi.stubEnv("PI_BASH_YIELD_MS", "250");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "500");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(500);
  });

  it("ignores partial environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "250ms");
    vi.stubEnv("PI_BASH_YIELD_MS", "500");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("reads only strict signed decimal environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "+250");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBe(250);

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "0x10");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();

    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "1e2");
    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });

  it("ignores unsafe environment integers", () => {
    vi.stubEnv("OPENCLAW_BASH_YIELD_MS", "9007199254740993");

    expect(readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS")).toBeUndefined();
  });
});

describe("deriveSessionName", () => {
  it("labels well-formed quoted commands", () => {
    expect(deriveSessionName('node "my server.js" --port 8080')).toBe("node my server.js");
    expect(deriveSessionName("git commit -m 'fix bug'")).toBe("git commit");
  });

  it("keeps grouping backslash-bearing quoted spans into one token", () => {
    expect(deriveSessionName('tar "a\\b c"')).toBe("tar a\\b c");
  });

  it("treats backslash as literal inside single-quoted spans", () => {
    expect(deriveSessionName("cmd 'a b\\' next")).toBe("cmd a b\\");
  });

  it("returns a label without catastrophic backtracking on unterminated quoted backslash runs", () => {
    for (const quote of [`"`, `'`]) {
      const malicious = `node ${quote}${"\\".repeat(50000)}`;
      const start = process.hrtime.bigint();
      const label = deriveSessionName(malicious);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      expect(typeof label).toBe("string");
      expect(elapsedMs).toBeLessThan(100);
    }
  });
});

describe("chunkString", () => {
  it("preserves surrogate pairs at chunk boundaries", () => {
    const input = "a".repeat(8191) + "🚀b";
    expect(chunkString(input, 8192)).toEqual(["a".repeat(8191), "🚀b"]);
  });

  it("returns single chunk for input smaller than limit", () => {
    expect(chunkString("hello", 8192)).toEqual(["hello"]);
  });

  it("emits a whole code point when the limit is one UTF-16 unit", () => {
    expect(chunkString("😀a", 1)).toEqual(["😀", "a"]);
  });

  it("preserves every code point across mixed chunk boundaries", () => {
    expect(chunkString("aa🚀bb", 2)).toEqual(["aa", "🚀", "bb"]);
  });
});
