// Model list table tests cover terminal table rendering for model list output.
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";

describe("printModelTable", () => {
  it("prints effective and native context values when a runtime cap differs", () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const rows: ModelRow[] = [
      {
        key: "openai/gpt-5.5",
        name: "GPT-5.5",
        input: "text+image",
        contextWindow: 400_000,
        contextTokens: 272_000,
        local: false,
        available: true,
        tags: [],
        missing: false,
      },
    ];

    printModelTable(rows, runtime as never);

    // Decimal windows render in decimal K: 272000 -> "272k", 400000 -> "400k".
    expect(runtime.log.mock.calls).toEqual([
      ["Model                                      Input      Ctx         Local Auth  Tags"],
      ["openai/gpt-5.5                             text+image 272k/400k   no    yes   "],
    ]);
  });

  it("keeps fixed-width rows aligned when model keys contain wide graphemes", () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const wideKey = `${"a".repeat(41)}表`;
    const rows: ModelRow[] = [
      {
        key: wideKey,
        name: wideKey,
        input: "text",
        contextWindow: 128_000,
        contextTokens: undefined,
        local: false,
        available: true,
        tags: [],
        missing: false,
      },
    ];

    printModelTable(rows, runtime as never);

    const [header, row] = runtime.log.mock.calls.map(([line]) => line);
    expect(typeof header).toBe("string");
    expect(typeof row).toBe("string");
    const headerInputIndex = (header as string).indexOf("Input");
    const rowInputIndex = (row as string).indexOf("text");
    expect(headerInputIndex).toBeGreaterThan(0);
    expect(rowInputIndex).toBeGreaterThan(0);
    expect(visibleWidth((row as string).slice(0, rowInputIndex))).toBe(
      visibleWidth((header as string).slice(0, headerInputIndex)),
    );
  });
});
