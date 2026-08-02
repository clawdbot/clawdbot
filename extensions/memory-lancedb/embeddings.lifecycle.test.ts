import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";

const providerMocks = vi.hoisted(() => ({
  getMemoryEmbeddingProvider: vi.fn(),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  getMemoryEmbeddingProvider: providerMocks.getMemoryEmbeddingProvider,
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  resolveDefaultAgentId: providerMocks.resolveDefaultAgentId,
}));

import { createEmbeddings } from "./embeddings.js";

function createApi(): OpenClawPluginApi {
  const config = {};
  return {
    config,
    runtime: {
      config: { current: () => config },
      agent: { resolveAgentDir: () => "/tmp/openclaw-agent" },
    },
  } as unknown as OpenClawPluginApi;
}

const embeddingConfig = {
  provider: "openai",
  model: "text-embedding-3-small",
} as MemoryConfig["embedding"];

describe("memory-lancedb provider lifecycle", () => {
  it("queues replacement behind close intent while provider creation is pending", async () => {
    let releaseFirstCreate: () => void = () => {};
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const closeProvider = vi.fn(async () => {});
    const createProvider = vi.fn(async () => {
      if (createProvider.mock.calls.length === 1) {
        await firstCreateGate;
      }
      return {
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: closeProvider,
        },
      };
    });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });

    const first = createEmbeddings(createApi(), { embedding: embeddingConfig } as MemoryConfig);
    const firstEmbed = first.embed("first");
    await vi.waitFor(() => expect(createProvider).toHaveBeenCalledTimes(1));

    const closePromise = first.close?.();
    const replacement = createEmbeddings(createApi(), {
      embedding: embeddingConfig,
    } as MemoryConfig);
    const replacementEmbed = replacement.embed("replacement");
    await Promise.resolve();
    expect(createProvider).toHaveBeenCalledTimes(1);

    releaseFirstCreate();
    await firstEmbed;
    await closePromise;
    await replacementEmbed;

    expect(closeProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(
      expectDefined(closeProvider.mock.invocationCallOrder[0], "pending provider close order"),
    ).toBeLessThan(
      expectDefined(createProvider.mock.invocationCallOrder[1], "replacement create order"),
    );
    await replacement.close?.();
  });

  it("does not re-close a provider retired while an older provider still fails", async () => {
    const closeOlder = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("older close failed once"))
      .mockRejectedValueOnce(new Error("older close failed twice"))
      .mockResolvedValue(undefined);
    const closeCurrent = vi.fn(async () => {});
    const createProvider = vi
      .fn()
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "older",
          embedQuery: vi.fn(async () => [0.1]),
          embedBatch: vi.fn(async () => [[0.1]]),
          close: closeOlder,
        },
      })
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "current",
          embedQuery: vi.fn(async () => [0.2]),
          embedBatch: vi.fn(async () => [[0.2]]),
          close: closeCurrent,
        },
      });
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: createProvider,
    });

    const older = createEmbeddings(createApi(), { embedding: embeddingConfig } as MemoryConfig);
    const current = createEmbeddings(createApi(), { embedding: embeddingConfig } as MemoryConfig);
    await older.embed("older");
    await current.embed("current");

    await expect(older.close?.()).rejects.toThrow("older close failed once");
    await expect(current.close?.()).rejects.toThrow("older close failed twice");
    expect(closeCurrent).toHaveBeenCalledTimes(1);

    await expect(current.close?.()).resolves.toBeUndefined();
    expect(closeOlder).toHaveBeenCalledTimes(3);
    expect(closeCurrent).toHaveBeenCalledTimes(1);
  });

  it("drains an admitted embedding before provider close", async () => {
    let markEmbedStarted: () => void = () => {};
    const embedStarted = new Promise<void>((resolve) => {
      markEmbedStarted = resolve;
    });
    let releaseEmbed: () => void = () => {};
    const embedGate = new Promise<void>((resolve) => {
      releaseEmbed = resolve;
    });
    const closeProvider = vi.fn(async () => {});
    providerMocks.getMemoryEmbeddingProvider.mockReturnValue({
      id: "openai",
      create: vi.fn(async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: vi.fn(async () => {
            markEmbedStarted();
            await embedGate;
            return [0.1, 0.2, 0.3];
          }),
          embedBatch: vi.fn(async () => [[0.1, 0.2, 0.3]]),
          close: closeProvider,
        },
      })),
    });

    const embeddings = createEmbeddings(createApi(), {
      embedding: embeddingConfig,
    } as MemoryConfig);
    const embedPromise = embeddings.embed("active");
    await embedStarted;
    const closePromise = embeddings.close?.();
    await Promise.resolve();

    expect(closeProvider).not.toHaveBeenCalled();
    await expect(embeddings.embed("late")).rejects.toThrow("memory-lancedb embeddings are closed");

    releaseEmbed();
    await expect(embedPromise).resolves.toEqual([0.1, 0.2, 0.3]);
    await closePromise;
    expect(closeProvider).toHaveBeenCalledTimes(1);
  });
});
