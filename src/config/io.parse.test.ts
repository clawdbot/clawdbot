// Covers config file parsing errors and JSON5 compatibility behavior.
import { describe, expect, it, vi } from "vitest";
import { parseConfigJson5 } from "./config.js";

describe("parseConfigJson5", () => {
  it("uses native JSON parsing before JSON5 fallback", () => {
    const json5 = { parse: vi.fn(() => ({ fromJson5: true })) };

    const result = parseConfigJson5('{"gateway":{"mode":"local"}}', json5);

    expect(result).toEqual({ ok: true, parsed: { gateway: { mode: "local" } } });
    expect(json5.parse).not.toHaveBeenCalled();
  });

  it("falls back to JSON5 for authored config syntax", () => {
    const json5 = { parse: vi.fn(() => ({ gateway: { mode: "local" } })) };

    const result = parseConfigJson5("{ gateway: { mode: 'local' } }", json5);

    expect(result).toEqual({ ok: true, parsed: { gateway: { mode: "local" } } });
    expect(json5.parse).toHaveBeenCalledOnce();
  });
});
