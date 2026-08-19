import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { Embeddings } from "./embeddings.js";
import type { MemoryDB } from "./lancedb-store.js";
import { registerMemoryCli } from "./memory-cli.js";

function createHarness(params?: { embedError?: unknown; closeError?: Error }) {
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
  registerMemoryCli(
    { registerCli } as unknown as OpenClawPluginApi,
    { search } as unknown as MemoryDB,
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
