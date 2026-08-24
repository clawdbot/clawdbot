import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
} from "./memory-tool-manager.test-mocks.js";
import { createMemoryGetTool } from "./tools.js";
import { asOpenClawConfig, createMemoryGetToolOrThrow } from "./tools.test-helpers.js";

const lookup = "memory/entities/alpha.md";
const memoryHit = {
  status: "ok",
  text: "Memory entry",
  path: lookup,
  from: 1,
  lines: 1,
} as const;
const emptyRange = {
  status: "ok",
  text: "",
  path: lookup,
  from: 10,
  lines: 0,
} as const;
const memoryMiss = { status: "not_found", text: "", path: lookup } as const;
const wikiHit = {
  corpus: "wiki",
  path: lookup,
  title: "Alpha",
  kind: "entity",
  content: "Wiki entry",
  fromLine: 3,
  lineCount: 5,
} as const;
const { content: wikiContent, ...wikiDetails } = wikiHit;
const wikiPayload = { ...wikiDetails, status: "ok" as const, text: wikiContent };

beforeEach(() => {
  vi.useRealTimers();
  clearMemoryPluginState();
  resetMemoryToolMockState();
});

type MemoryCase = MemoryReadResult | Error;
type WikiCase = "unregistered" | null | Error | typeof wikiHit;

function prepareCase(memory: MemoryCase, wiki: WikiCase) {
  setMemoryReadFileImpl(async () => {
    if (memory instanceof Error) {
      throw memory;
    }
    return memory;
  });
  const get = vi.fn(async () => {
    if (wiki instanceof Error) {
      throw wiki;
    }
    return wiki === "unregistered" ? null : wiki;
  });
  if (wiki !== "unregistered") {
    registerMemoryCorpusSupplement("memory-wiki", { search: async () => [], get });
  }
  return get;
}

describe("memory_get corpus outcomes", () => {
  it.each([
    {
      name: "keeps a memory hit while reporting a successful wiki lookup",
      memory: memoryHit,
      wiki: wikiHit,
      expected: {
        ...memoryHit,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "ok" },
        ],
      },
    },
    {
      name: "keeps a successful empty range while reporting wiki failure",
      memory: emptyRange,
      wiki: new Error("wiki unavailable"),
      expected: {
        ...emptyRange,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "unavailable", error: "wiki unavailable" },
        ],
        warning: "Wiki corpus unavailable: wiki unavailable",
        error: "wiki unavailable",
      },
    },
    {
      name: "falls through from a memory miss to wiki content",
      memory: memoryMiss,
      wiki: wikiHit,
      expected: {
        ...wikiPayload,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "ok" },
        ],
      },
    },
    {
      name: "keeps wiki content when memory is unavailable",
      memory: new Error("memory unavailable"),
      wiki: wikiHit,
      expected: {
        ...wikiPayload,
        corpora: [
          { corpus: "memory", outcome: "unavailable", error: "memory unavailable" },
          { corpus: "wiki", outcome: "ok" },
        ],
        warning: "Memory corpus unavailable: memory unavailable",
        error: "memory unavailable",
      },
    },
    {
      name: "returns not found when every available corpus misses",
      memory: memoryMiss,
      wiki: null,
      expected: {
        ...memoryMiss,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "ok" },
        ],
      },
    },
    {
      name: "returns not found when wiki misses and memory is unavailable",
      memory: new Error("memory unavailable"),
      wiki: null,
      expected: {
        ...memoryMiss,
        corpora: [
          { corpus: "memory", outcome: "unavailable", error: "memory unavailable" },
          { corpus: "wiki", outcome: "ok" },
        ],
        warning: "Memory corpus unavailable: memory unavailable",
        error: "memory unavailable",
      },
    },
    {
      name: "keeps a proven miss when wiki is unavailable",
      memory: memoryMiss,
      wiki: new Error("wiki unavailable"),
      expected: {
        ...memoryMiss,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          { corpus: "wiki", outcome: "unavailable", error: "wiki unavailable" },
        ],
        warning: "Wiki corpus unavailable: wiki unavailable",
        error: "wiki unavailable",
      },
    },
    {
      name: "does not claim not found when no corpus was available",
      memory: new Error("memory unavailable"),
      wiki: new Error("wiki unavailable"),
      expected: {
        path: lookup,
        text: "",
        disabled: true,
        corpora: [
          { corpus: "memory", outcome: "unavailable", error: "memory unavailable" },
          { corpus: "wiki", outcome: "unavailable", error: "wiki unavailable" },
        ],
        warning:
          "Memory corpus unavailable: memory unavailable Wiki corpus unavailable: wiki unavailable",
        error: "memory unavailable; wiki unavailable",
      },
    },
    {
      name: "does not claim not found when memory failed and wiki is not registered",
      memory: new Error("memory unavailable"),
      wiki: "unregistered" as const,
      expected: {
        path: lookup,
        text: "",
        disabled: true,
        corpora: [
          { corpus: "memory", outcome: "unavailable", error: "memory unavailable" },
          { corpus: "wiki", outcome: "not-registered" },
        ],
        warning:
          "Memory corpus unavailable: memory unavailable Wiki corpus is not registered; results do not cover that requested corpus.",
        error: "memory unavailable",
      },
    },
  ])("$name", async ({ memory, wiki, expected }) => {
    const get = prepareCase(memory, wiki);

    const result = await createMemoryGetToolOrThrow().execute("call_get_all", {
      path: lookup,
      corpus: "all",
    });

    expect(result.details).toEqual(expected);
    if (wiki !== "unregistered") {
      expect(get).toHaveBeenCalledOnce();
    }
  });

  it.each([
    {
      name: "registered miss",
      wiki: null,
      expected: {
        ...memoryMiss,
        corpora: [{ corpus: "wiki", outcome: "ok" }],
      },
    },
    {
      name: "unregistered corpus",
      wiki: "unregistered" as const,
      expected: {
        path: lookup,
        text: "",
        corpora: [{ corpus: "wiki", outcome: "not-registered" }],
        warning: "Wiki corpus is not registered; results do not cover that requested corpus.",
      },
    },
    {
      name: "unavailable corpus",
      wiki: new Error("wiki unavailable"),
      expected: {
        path: lookup,
        text: "",
        corpora: [{ corpus: "wiki", outcome: "unavailable", error: "wiki unavailable" }],
        warning: "Wiki corpus unavailable: wiki unavailable",
        error: "wiki unavailable",
      },
    },
  ])("reports a wiki-only $name", async ({ wiki, expected }) => {
    prepareCase(memoryMiss, wiki);
    const result = await createMemoryGetToolOrThrow().execute("call_get_wiki", {
      path: lookup,
      corpus: "wiki",
    });
    expect(result.details).toEqual(expected);
  });

  it("uses deterministic surviving wiki content when another supplement fails", async () => {
    registerMemoryCorpusSupplement("z-wiki", {
      search: async () => [],
      get: async () => ({ ...wikiHit, content: "Zeta entry" }),
    });
    registerMemoryCorpusSupplement("m-broken", {
      search: async () => [],
      get: async () => {
        throw new Error("broken wiki");
      },
    });
    registerMemoryCorpusSupplement("a-wiki", { search: async () => [], get: async () => wikiHit });

    const result = await createMemoryGetToolOrThrow().execute("call_get_wiki_partial", {
      path: lookup,
      corpus: "wiki",
    });

    expect(result.details).toEqual({
      ...wikiPayload,
      corpora: [{ corpus: "wiki", outcome: "unavailable", error: "broken wiki" }],
      warning: "Wiki corpus unavailable: broken wiki",
      error: "broken wiki",
    });
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to corpus=%s supplements",
    async (corpus) => {
      const get = vi.fn(async () => wikiHit);
      registerMemoryCorpusSupplement("memory-wiki", { search: async () => [], get });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemoryGetTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_get tool");
      }

      await tool.execute(`call_get_${corpus}`, { path: lookup, from: 2, lines: 4, corpus });

      expect(get).toHaveBeenCalledWith({
        lookup,
        fromLine: 2,
        lineCount: 4,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
    },
  );

  it("settles a hanging supplement at the shared deadline and keeps memory", async () => {
    vi.useFakeTimers();
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => await new Promise<never>(() => {}),
    });
    setMemoryReadFileImpl(async () => memoryHit);

    const pending = createMemoryGetToolOrThrow().execute("call_get_deadline", {
      path: lookup,
      corpus: "all",
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toMatchObject({
      details: {
        ...memoryHit,
        corpora: [
          { corpus: "memory", outcome: "ok" },
          {
            corpus: "wiki",
            outcome: "unavailable",
            error: "memory_get timed out after 15s",
          },
        ],
      },
    });
  });

  it("cancels a hanging exact supplement read", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => await new Promise<never>(() => {}),
    });
    const controller = new AbortController();
    const pending = createMemoryGetToolOrThrow().execute(
      "call_get_abort",
      { path: lookup, corpus: "all" },
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});
