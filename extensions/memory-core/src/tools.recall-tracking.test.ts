// Memory Core tests cover tools.recall tracking plugin behavior.
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resetMemoryToolMockState, setMemorySearchImpl } from "./memory-tool-manager.test-mocks.js";
import { createMemorySearchTool } from "./tools.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type RecordShortTermRecallsFn = (params: {
  workspaceDir?: string;
  query: string;
  results: MemorySearchResult[];
  nowMs?: number;
  timezone?: string;
}) => Promise<void>;

const recallTrackingMock = vi.hoisted(() => ({
  recordShortTermRecalls: vi.fn<RecordShortTermRecallsFn>(async () => {}),
}));

vi.mock("./short-term-promotion.js", () => ({
  recordShortTermRecalls: recallTrackingMock.recordShortTermRecalls,
}));

function createSearchTool(config: OpenClawConfig) {
  const tool = createMemorySearchTool({ config });
  if (!tool) {
    throw new Error("memory_search tool missing");
  }
  return tool;
}

describe("memory_search recall tracking", () => {
  beforeEach(() => {
    clearMemoryPluginState();
    resetMemoryToolMockState();
    recallTrackingMock.recordShortTermRecalls.mockReset();
    recallTrackingMock.recordShortTermRecalls.mockResolvedValue(undefined);
  });

  it("reinforces only primary results shown after corpus balancing, preserving raw evidence", async () => {
    const rawResults = Array.from({ length: 4 }, (_, index) => ({
      path: `memory/2026-04-0${index + 1}.md`,
      startLine: 1,
      endLine: 2,
      score: 0.9 - index / 10,
      snippet: `Remember item ${index + 1}. <!-- importance: 8 -->`,
      source: "memory" as const,
    }));
    setMemorySearchImpl(async () => rawResults);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        { corpus: "wiki", path: "summary.md", score: 1, snippet: "Compiled summary." },
      ],
      get: async () => null,
    });
    const tool = createSearchTool({
      memory: { citations: "on" },
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
    });

    const result = await tool.execute("balanced_recall", {
      query: "remember",
      corpus: "all",
      maxResults: 2,
    });

    expect(result.details).toMatchObject({
      results: [{ path: "summary.md" }, { path: "memory/2026-04-01.md" }],
    });
    expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ results: [rawResults[0]] }),
    );
  });

  it("does not block tool results on slow best-effort recall writes", async () => {
    let resolveRecall: (() => void) | undefined;
    recallTrackingMock.recordShortTermRecalls.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveRecall = resolve;
        }),
    );

    const tool = createSearchTool(
      asOpenClawConfig({
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      }),
    );
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "Move backups to S3 Glacier.",
        source: "memory" as const,
      },
    ]);

    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        tool.execute("call_recall_non_blocking", { query: "glacier" }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("memory_search waited on recall persistence"));
          }, 200);
        }),
      ]);

      const details = result.details as { results: Array<{ path: string }> };
      expect(details.results).toHaveLength(1);
      expect(details.results[0]?.path).toBe("memory/2026-04-03.md");
      expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledTimes(1);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolveRecall?.();
    }
  });

  it("passes the resolved dreaming timezone into recall tracking", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "Move backups to S3 Glacier.",
        source: "memory" as const,
      },
    ]);

    const tool = createSearchTool(
      asOpenClawConfig({
        agents: {
          defaults: {
            userTimezone: "America/Los_Angeles",
          },
          list: [{ id: "main", default: true }],
        },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                  timezone: "Europe/London",
                },
              },
            },
          },
        },
      }),
    );

    await tool.execute("call_recall_timezone", { query: "glacier" });

    expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledTimes(1);
    const [firstCall] = recallTrackingMock.recordShortTermRecalls.mock.calls;
    expect(firstCall?.[0]?.timezone).toBe("Europe/London");
  });

  it("skips recall tracking when dreaming is disabled", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "Move backups to S3 Glacier.",
        source: "memory" as const,
      },
    ]);

    const tool = createSearchTool(
      asOpenClawConfig({
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
          },
        },
      }),
    );

    const result = await tool.execute("call_recall_disabled", { query: "glacier" });
    const details = result.details as { results: Array<{ path: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.path).toBe("memory/2026-04-03.md");
    expect(recallTrackingMock.recordShortTermRecalls).not.toHaveBeenCalled();
  });
});
