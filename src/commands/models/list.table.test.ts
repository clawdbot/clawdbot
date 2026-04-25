import { describe, expect, it, vi } from "vitest";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";

describe("printModelTable", () => {
  it("prints effective and native context values when a runtime cap differs", () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const rows: ModelRow[] = [
      {
        key: "openai-codex/gpt-5.5",
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

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("266k/391k"));
  });
});
