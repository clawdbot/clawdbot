import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { AgentSession } from "./agent-session.js";

describe("AgentSession context usage", () => {
  it("preserves an earlier exact snapshot when unavailable usage precedes any compaction", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "large exact response" }],
        stopReason: "stop",
        usage: {
          input: 180_000,
          output: 10_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 190_000,
          contextUsage: {
            state: "available" as const,
            promptTokens: 180_000,
            totalTokens: 190_000,
          },
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      },
      { role: "user", content: "small follow-up" },
      {
        role: "assistant",
        content: [{ type: "text", text: "small answer" }],
        stopReason: "stop",
        usage: {
          input: 12,
          output: 8,
          cacheRead: 180_000,
          cacheWrite: 0,
          totalTokens: 180_020,
          contextUsage: { state: "unavailable" as const },
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
      },
    ] as unknown as AgentMessage[];

    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => [] },
    } as unknown as AgentSession);

    expect(usage?.tokens).toBeGreaterThan(190_000);
  });

  it("uses a content estimate after compaction when provider context usage is unavailable", () => {
    const unavailableUsage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      totalTokens: 927_907,
      contextUsage: { state: "unavailable" as const },
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "retained answer" }],
        stopReason: "stop",
        usage: {
          ...unavailableUsage,
          contextUsage: {
            state: "available" as const,
            promptTokens: 120_000,
            totalTokens: 125_000,
          },
        },
      },
      { role: "user", content: "new prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "new answer" }],
        stopReason: "stop",
        usage: unavailableUsage,
      },
    ] as unknown as AgentMessage[];
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-07-05T00:00:00.000Z",
        summary: "summary",
        firstKeptEntryId: "assistant-old",
        tokensBefore: 120_000,
      },
      {
        type: "message",
        id: "assistant-new",
        parentId: "compact-1",
        timestamp: "2026-07-05T00:00:01.000Z",
        message: messages[2],
      },
    ];

    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

    expect(usage?.tokens).not.toBeNull();
    expect(usage?.tokens).toBeLessThan(1_000);
  });

  it("preserves an earlier exact post-compaction snapshot before an unavailable response", () => {
    const exactUsage = {
      input: 180_000,
      output: 10_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 190_000,
      contextUsage: {
        state: "available" as const,
        promptTokens: 180_000,
        totalTokens: 190_000,
      },
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "exact post-compaction answer" }],
        stopReason: "stop",
        usage: exactUsage,
      },
      { role: "user", content: "small follow-up" },
      {
        role: "assistant",
        content: [{ type: "text", text: "small answer" }],
        stopReason: "stop",
        usage: {
          ...exactUsage,
          contextUsage: { state: "unavailable" as const },
        },
      },
    ] as unknown as AgentMessage[];
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-07-05T00:00:00.000Z",
        summary: "summary",
        firstKeptEntryId: "assistant-exact",
        tokensBefore: 120_000,
      },
      {
        type: "message",
        id: "assistant-exact",
        parentId: "compact-1",
        timestamp: "2026-07-05T00:00:01.000Z",
        message: messages[0],
      },
      {
        type: "message",
        id: "assistant-unavailable",
        parentId: "assistant-exact",
        timestamp: "2026-07-05T00:00:02.000Z",
        message: messages[2],
      },
    ];

    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

    expect(usage?.tokens).toBeGreaterThan(190_000);
  });

  it("preserves an earlier exact post-compaction snapshot before zero usage", () => {
    const exactUsage = {
      input: 180_000,
      output: 10_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 190_000,
      contextUsage: {
        state: "available" as const,
        promptTokens: 180_000,
        totalTokens: 190_000,
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      contextUsage: { state: "available" as const, promptTokens: 0, totalTokens: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "exact post-compaction answer" }],
        stopReason: "stop",
        usage: exactUsage,
      },
      { role: "user", content: "small follow-up" },
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
        usage: zeroUsage,
      },
    ] as unknown as AgentMessage[];
    const branchEntries = [
      {
        type: "compaction",
        id: "compact-1",
        parentId: null,
        timestamp: "2026-07-05T00:00:00.000Z",
        summary: "summary",
        firstKeptEntryId: "assistant-exact",
        tokensBefore: 120_000,
      },
      {
        type: "message",
        id: "assistant-exact",
        parentId: "compact-1",
        timestamp: "2026-07-05T00:00:01.000Z",
        message: messages[0],
      },
      {
        type: "message",
        id: "assistant-zero",
        parentId: "assistant-exact",
        timestamp: "2026-07-05T00:00:02.000Z",
        message: messages[2],
      },
    ];

    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

    expect(usage?.tokens).toBeGreaterThan(190_000);
  });
});
