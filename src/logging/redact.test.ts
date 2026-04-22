import { describe, expect, it } from "vitest";
import {
  getDefaultRedactPatterns,
  redactSensitiveLines,
  redactSensitiveText,
  resolveRedactOptions,
} from "./redact.js";

const defaults = getDefaultRedactPatterns();

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks hook token CLI flags", () => {
    const input = "gog gmail watch serve --hook-token abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("gog gmail watch serve --hook-token abcdef…ghij");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks bot-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("123456…cdef");
  });

  it("masks bot API URL tokens", () => {
    const input =
      "GET https://api.example.test/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/getMe HTTP/1.1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET https://api.example.test/bot123456…cdef/getMe HTTP/1.1");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("TOKEN=***");
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      ["-----BEGIN PRIVATE KEY-----", "…redacted…", "-----END PRIVATE KEY-----"].join("\n"),
    );
  });

  it("honors custom patterns with flags", () => {
    const input = "token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/token=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("token=abcdef…ghij");
  });

  it("ignores unsafe nested-repetition custom patterns", () => {
    const input = `${"a".repeat(28)}!`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["(a+)+$"],
    });
    expect(output).toBe(input);
  });

  it("redacts large payloads with bounded regex passes", () => {
    const input = `${"x".repeat(40_000)} OPENAI_API_KEY=sk-1234567890abcdef ${"y".repeat(40_000)}`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("skips redaction when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "off",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });

  it("does not resolve patterns when mode is off", () => {
    const options = {
      mode: "off" as const,
      get patterns(): never {
        throw new Error("patterns should not be read when redaction is off");
      },
    };

    expect(resolveRedactOptions(options)).toEqual({
      mode: "off",
      patterns: [],
    });
    expect(redactSensitiveText("OPENAI_API_KEY=sk-1234567890abcdef", options)).toBe(
      "OPENAI_API_KEY=sk-1234567890abcdef",
    );
  });

  it("reuses compiled global regex patterns", () => {
    const pattern = /token=([A-Za-z0-9]+)/g;
    const resolved = resolveRedactOptions({
      mode: "tools",
      patterns: [pattern],
    });

    expect(resolved.patterns).toHaveLength(1);
    expect(resolved.patterns[0]).toBe(pattern);
  });
});

describe("redactSensitiveLines", () => {
  it("redacts matching content across all lines", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: defaults });
    const lines = ["curl --token abcdef1234567890ghij https://api.test", "normal log line"];
    const result = redactSensitiveLines(lines, resolved);
    expect(result[0]).toBe("curl --token abcdef…ghij https://api.test");
    expect(result[1]).toBe("normal log line");
  });

  it("returns lines unmodified when mode is off", () => {
    const resolved = resolveRedactOptions({ mode: "off", patterns: defaults });
    const lines = ["TOKEN=abcdef1234567890ghij"];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("returns lines unmodified when resolved patterns is empty — does not fall back to defaults", () => {
    // Simulates the case where all user-configured patterns fail to compile.
    // The pre-resolved empty array must be honored, not silently replaced with defaults.
    const resolved = { mode: "tools" as const, patterns: [] };
    const lines = ["TOKEN=abcdef1234567890ghij"];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("returns empty array unchanged — does not produce a synthetic blank line", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: defaults });
    expect(redactSensitiveLines([], resolved)).toEqual([]);
  });

  it("redacts a PEM block spanning multiple lines in the array", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: defaults });
    const lines = [
      "log: key follows",
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
      "log: key done",
    ];
    const result = redactSensitiveLines(lines, resolved);
    const joined = result.join("\n");
    expect(joined).toContain("-----BEGIN PRIVATE KEY-----");
    expect(joined).toContain("-----END PRIVATE KEY-----");
    expect(joined).toContain("…redacted…");
    expect(joined).not.toContain("ABCDEF1234567890");
  });
});
