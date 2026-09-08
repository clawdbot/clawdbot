import { tableFromArrays } from "apache-arrow";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { Embeddings } from "./embeddings.js";
import type { MemoryDB } from "./lancedb-store.js";
import { registerMemoryCli } from "./memory-cli.js";

function createHarness(params?: {
  embedError?: unknown;
  closeError?: Error;
  queryRows?: Record<string, unknown>[];
}) {
  const registerCli = vi.fn();
  const closeError = params?.closeError;
  const close = closeError
    ? vi.fn(async () => {
        throw closeError;
      })
    : vi.fn(async () => {});
  const embed =
    params && Object.hasOwn(params, "embedError")
      ? vi.fn(async () => {
          throw params.embedError;
        })
      : vi.fn(async () => [0.1, 0.2]);
  const embeddings: Embeddings = {
    embed,
    close,
  };
  const search = vi.fn(async () => []);
  const query = vi.fn(async () => params?.queryRows ?? []);
  registerMemoryCli(
    { registerCli } as unknown as OpenClawPluginApi,
    { search, query } as unknown as MemoryDB,
    embeddings,
    (rawAgentId) => (typeof rawAgentId === "string" ? rawAgentId : "main"),
    () => ({
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      captureMaxChars: 500,
      recallMaxChars: 1000,
    }),
  );
  const registrar = registerCli.mock.calls[0]?.[0] as
    | ((params: { program: Command }) => void)
    | undefined;
  if (!registrar) {
    throw new Error("expected memory CLI registrar");
  }
  const program = new Command();
  registrar({ program });
  return { close, embed, program, search };
}

describe("memory-lancedb CLI embedding lifecycle", () => {
  it("closes embeddings after search", async () => {
    const harness = createHarness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await harness.program.parseAsync(["node", "openclaw", "ltm", "search", "hello"]);
    } finally {
      log.mockRestore();
    }

    expect(harness.embed).toHaveBeenCalledTimes(1);
    expect(harness.search).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("embeds a CLI search with the explicitly requested agent's authentication", async () => {
    const harness = createHarness();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await harness.program.parseAsync([
        "node",
        "openclaw",
        "ltm",
        "search",
        "private account memory",
        "--agent",
        "private",
      ]);
    } finally {
      log.mockRestore();
    }

    expect(harness.embed).toHaveBeenCalledWith("private", "private account memory", {
      provider: "openai",
      model: "text-embedding-3-small",
    });
    expect(harness.search).toHaveBeenCalledWith("private", [0.1, 0.2], 5, 0.3);
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("closes embeddings without masking search failure", async () => {
    const harness = createHarness({
      embedError: new Error("embedding failed"),
      closeError: new Error("close failed"),
    });

    await expect(
      harness.program.parseAsync(["node", "openclaw", "ltm", "search", "hello"]),
    ).rejects.toThrow("embedding failed");
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid limit before generating an embedding", async () => {
    const harness = createHarness();

    await expect(
      harness.program.parseAsync([
        "node",
        "openclaw",
        "ltm",
        "search",
        "hello",
        "--limit",
        "5items",
      ]),
    ).rejects.toThrow("--limit must be a positive integer");

    expect(harness.embed).not.toHaveBeenCalled();
    expect(harness.search).not.toHaveBeenCalled();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a falsy search rejection over cleanup failure", async () => {
    const harness = createHarness({
      embedError: null,
      closeError: new Error("close failed"),
    });

    const rejection = await harness.program
      .parseAsync(["node", "openclaw", "ltm", "search", "hello"])
      .then(
        () => "resolved",
        (err: unknown) => err,
      );
    expect(rejection).toBeNull();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });
});

describe("memory-lancedb CLI query output", () => {
  it.each([
    { columns: "id,text", order: "createdAt:asc", ids: ["first", "second"] },
    { columns: "id,text", order: "createdAt:desc", ids: ["third", "second"] },
    { columns: "id,text,createdAt", order: "createdAt:asc", ids: ["first", "second"] },
  ])(
    "projects $columns ordered by $order without mutating Arrow rows",
    async ({ columns, order, ids }) => {
      const table = tableFromArrays({
        id: ["third", "first", "second"],
        text: ["third memory", "first memory", "second memory"],
        createdAt: [30, 10, 20],
      });
      const originalRows = table.toArray().map((row) => row.toJSON());
      const harness = createHarness({ queryRows: table.toArray() });
      let stdout = "";
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
      try {
        await harness.program.parseAsync([
          "node",
          "openclaw",
          "ltm",
          "query",
          "--cols",
          columns,
          "--order-by",
          order,
          "--limit",
          "2",
        ]);
      } finally {
        write.mockRestore();
      }

      const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
      expect(rows.map((row) => row.id)).toEqual(ids);
      expect(rows.map((row) => Object.keys(row))).toEqual(ids.map(() => columns.split(",")));
      expect(rows.map((row) => row.text)).toEqual(ids.map((id) => `${id} memory`));
      expect(table.toArray().map((row) => row.toJSON())).toEqual(originalRows);
      expect(harness.embed).not.toHaveBeenCalled();
    },
  );
});
