import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemorySearchImpl,
} from "./memory-tool-manager-mock.js";
import { createMemorySearchTool } from "./tools.js";

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

function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config;
}

function createSearchTool(config: OpenClawConfig) {
  const tool = createMemorySearchTool({ config });
  if (!tool) {
    throw new Error("memory_search tool missing");
  }
  return tool;
}

describe("memory_search recall tracking", () => {
  beforeEach(() => {
    resetMemoryToolMockState();
    recallTrackingMock.recordShortTermRecalls.mockReset();
    recallTrackingMock.recordShortTermRecalls.mockResolvedValue(undefined);
  });

  it("records only surfaced results after qmd clamp", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async () => [
      {
        path: "memory/2026-04-03.md",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        snippet: "A".repeat(80),
        source: "memory" as const,
      },
      {
        path: "memory/2026-04-02.md",
        startLine: 1,
        endLine: 2,
        score: 0.92,
        snippet: "B".repeat(80),
        source: "memory" as const,
      },
    ]);

    const tool = createSearchTool(
      asOpenClawConfig({
        agents: { list: [{ id: "main", default: true }] },
        memory: {
          backend: "qmd",
          citations: "on",
          qmd: { limits: { maxInjectedChars: 100 } },
        },
      }),
    );

    const result = await tool.execute("call_recall_clamp", { query: "backup glacier" });
    const details = result.details as { results: Array<{ path: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.path).toBe("memory/2026-04-03.md");

    expect(recallTrackingMock.recordShortTermRecalls).toHaveBeenCalledTimes(1);
    const [firstCall] = recallTrackingMock.recordShortTermRecalls.mock.calls;
    expect(firstCall).toBeDefined();
    const recallParams = firstCall[0];
    expect(recallParams.results).toHaveLength(1);
    expect(recallParams.results[0]?.path).toBe("memory/2026-04-03.md");
    expect(recallParams.results[0]?.snippet).not.toContain("Source:");
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
});
