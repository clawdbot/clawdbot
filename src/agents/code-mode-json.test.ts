import { describe, expect, it } from "vitest";
import {
  boundCodeModeError,
  captureCodeModeOutput,
  captureCodeModeValue,
  CodeModeOutputState,
  toCodeModeJsonSafe,
} from "./code-mode-json.js";

describe("Code Mode JSON normalization", () => {
  it.each([
    { limit: 20, prefix: "" },
    { limit: 24, prefix: 'a"' },
    { limit: 35, prefix: 'a"\\\n\r\t\b\f' },
    { limit: 50, prefix: 'a"\\\n\r\t\b\f\u0000\u0001é' },
    { limit: 72, prefix: 'a"\\\n\r\t\b\f\u0000\u0001é中🌍�za"\\\n\r\t' },
  ])("fits escaped diagnostics at $limit bytes", ({ limit, prefix }) => {
    const error = 'a"\\\n\r\t\b\f\u0000\u0001é中🌍\ud800z'.repeat(8);
    expect(boundCodeModeError(error, limit)).toBe(`${prefix} [error truncated]`);
  });

  it("preserves whole lone surrogates and decodes only partial diagnostics", () => {
    expect(boundCodeModeError("\ud800x", 20)).toBe("\ud800x");
    expect(boundCodeModeError("\ud800".repeat(6), 30)).toBe("��� [error truncated]");
  });

  it.each([
    { limit: 107, prefix: "", omittedBytes: 1000 },
    { limit: 108, prefix: '"', omittedBytes: 999 },
    { limit: 109, prefix: '"a', omittedBytes: 998 },
  ])("fits marker digit-width transitions at $limit bytes", ({ limit, prefix, omittedBytes }) => {
    expect(
      new CodeModeOutputState(limit).take({ value: captureCodeModeValue("a".repeat(998), limit) })
        .value,
    ).toEqual({
      truncated: true,
      omittedBytes,
      guidance: "Output truncated; rerun with narrower args.",
      prefix,
    });
  });

  it.each([
    { name: "undefined", value: undefined, expected: null },
    { name: "null", value: null, expected: null },
    { name: "true", value: true, expected: true },
    { name: "false", value: false, expected: false },
    { name: "empty text", value: "", expected: "" },
    { name: "Unicode and escapes", value: '\ud800"\\\n🌍漢字', expected: '\ud800"\\\n🌍漢字' },
    { name: "negative zero", value: -0, expected: 0 },
    { name: "NaN", value: Number.NaN, expected: null },
    { name: "infinity", value: Infinity, expected: null },
    { name: "bigint", value: 12n, expected: "12" },
    { name: "symbol", value: Symbol("synthetic"), expected: null },
    { name: "ordinary Error", value: new Error("synthetic"), expected: {} },
  ])("preserves $name through normalization and capture", ({ value, expected }) => {
    expect(toCodeModeJsonSafe(value)).toEqual(expected);
    expect(captureCodeModeValue(value, 1_024)).toEqual({
      kind: "complete",
      json: JSON.stringify(expected),
    });
  });

  it("keeps captured and delivered structured values detached from later mutation", async () => {
    const input = { nested: { label: "before" }, items: ["before"] };
    const normalized = toCodeModeJsonSafe(input);
    const captured = captureCodeModeValue(input, 1_024);
    input.nested.label = "after";
    input.items.push("after");
    expect(normalized).toEqual({ nested: { label: "before" }, items: ["before"] });
    expect(captured).toEqual({
      kind: "complete",
      json: '{"nested":{"label":"before"},"items":["before"]}',
    });

    const state = new CodeModeOutputState(65_536, { maxChars: 2_048, maxContextChars: 4_096 });
    state.append(captureCodeModeOutput([{ type: "text", text: "x".repeat(10_000) }], 65_536));
    const first = state.takeResult({ status: "completed" }, { value: captured });
    expect(first.value).toEqual(normalized);
    expect(first.output).toEqual([expect.objectContaining({ truncated: true })]);
    if (!first.value || typeof first.value !== "object") {
      throw new Error("Expected a structured delivered value");
    }
    Object.assign(first.value, { nested: { label: "changed after delivery" } });
    await Promise.resolve();

    const second = state.takeResult({ status: "completed" }, { value: captured });
    expect(second).toMatchObject({ value: normalized, output: [] });
    state.append(captureCodeModeOutput([{ type: "text", text: "next" }], 65_536));
    expect(
      state.takeResult({ status: "completed" }, { value: captureCodeModeValue(null, 65_536) })
        .value,
    ).toBeNull();
  });

  it("retains cycle fallbacks and normalizes each output entry with the root toJSON key", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = Object.assign(new Error("synthetic"), { cyclic });
    expect(toCodeModeJsonSafe(cyclic)).toBe("[object Object]");
    expect(toCodeModeJsonSafe(error)).toEqual({ name: "Error", message: "synthetic" });
    const keys: string[] = [];
    const output: unknown[] = [];
    output[2] = {
      toJSON(key: string) {
        keys.push(key);
        return { value: "kept" };
      },
    };
    expect(captureCodeModeOutput(output, 1_024)).toEqual({
      count: 3,
      source: { kind: "complete", json: '[null,null,{"value":"kept"}]' },
    });
    expect(keys).toEqual([""]);
    expect(Object.hasOwn(output, 0)).toBe(false);
  });
});
