import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const getMemorySearchManager = vi.fn();
const loadConfig = vi.fn(() => ({}));
const resolveDefaultAgentId = vi.fn(() => "main");

vi.mock("../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

afterEach(async () => {
  vi.restoreAllMocks();
  getMemorySearchManager.mockReset();
  process.exitCode = undefined;
  const { setVerbose } = await import("../globals.js");
  setVerbose(false);
});

describe("memory cli", () => {
  it("prints vector status when available", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => ({
          files: 2,
          chunks: 5,
          dirty: false,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          cache: { enabled: true, entries: 123, maxEntries: 50000 },
          fts: { enabled: true, available: true },
          vector: {
            enabled: true,
            available: true,
            extensionPath: "/opt/sqlite-vec.dylib",
            dims: 1024,
          },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status"], { from: "user" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: ready"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector dims: 1024"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector path: /opt/sqlite-vec.dylib"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FTS: ready"));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Embedding cache: enabled (123 entries)"),
    );
    expect(close).toHaveBeenCalled();
  });

  it("prints vector error when unavailable", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => false),
        status: () => ({
          files: 0,
          chunks: 0,
          dirty: true,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: {
            enabled: true,
            available: false,
            loadError: "load failed",
          },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--agent", "main"], { from: "user" });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector: unavailable"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Vector error: load failed"));
    expect(close).toHaveBeenCalled();
  });

  it("prints embeddings status when deep", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        probeEmbeddingAvailability,
        status: () => ({
          files: 1,
          chunks: 1,
          dirty: false,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: { enabled: true, available: true },
        }),
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--deep"], { from: "user" });

    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Embeddings: ready"));
    expect(close).toHaveBeenCalled();
  });

  it("enables verbose logging with --verbose", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { isVerbose } = await import("../globals.js");
    const close = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => ({
          files: 0,
          chunks: 0,
          dirty: false,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: { enabled: true, available: true },
        }),
        close,
      },
    });

    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--verbose"], { from: "user" });

    expect(isVerbose()).toBe(true);
  });

  it("logs close failure after status", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        status: () => ({
          files: 1,
          chunks: 1,
          dirty: false,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
        }),
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status"], { from: "user" });

    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("reindexes on status --index", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    const probeEmbeddingAvailability = vi.fn(async () => ({ ok: true }));
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        probeVectorAvailability: vi.fn(async () => true),
        probeEmbeddingAvailability,
        sync,
        status: () => ({
          files: 1,
          chunks: 1,
          dirty: false,
          workspaceDir: "/tmp/clawd",
          dbPath: "/tmp/memory.sqlite",
          provider: "openai",
          model: "text-embedding-3-small",
          requestedProvider: "openai",
          vector: { enabled: true, available: true },
        }),
        close,
      },
    });

    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "status", "--index"], { from: "user" });

    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "cli", progress: expect.any(Function) }),
    );
    expect(probeEmbeddingAvailability).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes manager after index", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const sync = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        sync,
        close,
      },
    });

    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "index"], { from: "user" });

    expect(sync).toHaveBeenCalledWith({ reason: "cli", force: false });
    expect(close).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Memory index updated.");
  });

  it("logs close failures without failing the command", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    const sync = vi.fn(async () => {});
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        sync,
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "index"], { from: "user" });

    expect(sync).toHaveBeenCalledWith({ reason: "cli", force: false });
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("logs close failure after search", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {
      throw new Error("close boom");
    });
    const search = vi.fn(async () => [
      {
        path: "memory/2026-01-12.md",
        startLine: 1,
        endLine: 2,
        score: 0.5,
        snippet: "Hello",
      },
    ]);
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        search,
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "search", "hello"], { from: "user" });

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Memory manager close failed: close boom"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("closes manager after search error", async () => {
    const { registerMemoryCli } = await import("./memory-cli.js");
    const { defaultRuntime } = await import("../runtime.js");
    const close = vi.fn(async () => {});
    const search = vi.fn(async () => {
      throw new Error("boom");
    });
    getMemorySearchManager.mockResolvedValueOnce({
      manager: {
        search,
        close,
      },
    });

    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const program = new Command();
    program.name("test");
    registerMemoryCli(program);
    await program.parseAsync(["memory", "search", "oops"], { from: "user" });

    expect(search).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Memory search failed: boom"));
    expect(process.exitCode).toBe(1);
  });
});
