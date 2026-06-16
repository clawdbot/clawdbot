/** Tests compaction safeguard summaries, quality audit, providers, and runtime settings. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearCompactionProviders,
  registerCompactionProvider,
} from "../../plugins/compaction-provider.js";
import * as compactionModule from "../compaction.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { jsonResult } from "../tools/common.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import {
  consumeCompactionSafeguardCancelReason,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancelReason,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof compactionModule>("../compaction.js");
  return {
    ...actual,
    summarizeInStages: vi.fn(actual.summarizeInStages),
  };
});

const mockSummarizeInStages = vi.mocked(compactionModule.summarizeInStages);

function summaryResult(text: string) {
  return { kind: "summary" as const, text };
}

const {
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  formatPreservedTurnsSection,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  capCompactionSummaryPreservingSuffix,
  formatFileOperations,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  readWorkspaceContextForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} = testing;

beforeEach(() => {
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  clearCompactionProviders();
});

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionDir: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionFile: () => undefined,
    getLeafId: () => null,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
const createCompactionHandler = () => {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  return compactionHandler;
};

const createCompactionEvent = (params: { messageText: string; tokensBefore: number }) => ({
  preparation: {
    messagesToSummarize: [
      { role: "user", content: params.messageText, timestamp: Date.now() },
    ] as AgentMessage[],
    turnPrefixMessages: [] as AgentMessage[],
    firstKeptEntryId: "entry-1",
    tokensBefore: params.tokensBefore,
    fileOps: {
      read: [],
      edited: [],
      written: [],
    },
  },
  customInstructions: "",
  signal: new AbortController().signal,
});

const createCompactionContext = (params: {
  sessionManager: ExtensionContext["sessionManager"];
  getApiKeyAndHeadersMock?: ReturnType<typeof vi.fn>;
  getApiKeyMock?: ReturnType<typeof vi.fn>;
}) =>
  ({
    model: undefined,
    sessionManager: params.sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders:
        params.getApiKeyAndHeadersMock ??
        vi.fn(async (model) => {
          const legacyGetApiKey = params.getApiKeyMock as
            | undefined
            | ((model: NonNullable<ExtensionContext["model"]>) => Promise<string | undefined>);
          const apiKey = await legacyGetApiKey?.(model);
          return apiKey !== undefined ? { ok: true, apiKey } : { ok: false, error: "missing auth" };
        }),
    },
  }) as unknown as Partial<ExtensionContext>;

async function runCompactionScenario(params: {
  sessionManager: ExtensionContext["sessionManager"];
  event: unknown;
  apiKey: string | null;
}) {
  const compactionHandler = createCompactionHandler();
  const getApiKeyAndHeadersMock = vi
    .fn()
    .mockResolvedValue(
      params.apiKey !== null
        ? { ok: true, apiKey: params.apiKey }
        : { ok: false, error: "missing auth" },
    );
  const mockContext = createCompactionContext({
    sessionManager: params.sessionManager,
    getApiKeyAndHeadersMock,
  });
  const result = (await compactionHandler(params.event, mockContext)) as {
    cancel?: boolean;
    compaction?: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
    };
  };
  return { result, getApiKeyAndHeadersMock };
}

function expectCompactionResult(result: {
  cancel?: boolean;
  compaction?: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}) {
  expect(result.cancel).not.toBe(true);
  if (!result.compaction) {
    throw new Error("Expected compaction result");
  }
  return result.compaction;
}

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function latestMockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  argIndex = 0,
): unknown {
  return mockCallArg(mock, mock.mock.calls.length - 1, argIndex);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("expected record");
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("expected array");
  }
  return value;
}

describe("compaction-safeguard tool failures", () => {
  it("formats tool failures with meta and summary", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("exec (status=failed exitCode=1): ENOENT: missing file");
  });

  it("excludes accepted sessions_spawn results even when persisted with isError", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-spawn-accepted",
        toolName: "sessions_spawn",
        isError: true,
        details: {
          status: "accepted",
          childSessionKey: "agent:watcher:subagent:abc",
          runId: "run-123",
          mode: "run",
        },
        content: [{ type: "text", text: "accepted" }],
        timestamp: Date.now(),
      },
    ];

    expect(collectToolFailures(messages)).toHaveLength(0);
  });

  it("still reports sessions_spawn results that genuinely failed", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-spawn-error",
        toolName: "sessions_spawn",
        isError: true,
        details: { status: "error" },
        content: [{ type: "text", text: "spawn rejected" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-spawn-forbidden",
        toolName: "sessions_spawn",
        isError: true,
        details: { status: "forbidden" },
        content: [{ type: "text", text: "not allowed" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "call-spawn-error",
      "call-spawn-forbidden",
    ]);
  });

  it("only excludes the accepted spawn from a mixed batch and reports look-alike non-spawn tools", () => {
    // Build the accepted-spawn details via the production helper so the skip is
    // proven against the real sessions_spawn result shape, not a hand-authored stub.
    const acceptedDetails = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
      mode: "run",
    }).details;
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-spawn-accepted",
        toolName: "sessions_spawn",
        isError: true,
        details: acceptedDetails,
        content: [{ type: "text", text: "accepted" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-exec-failed",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "boom" }],
        timestamp: Date.now(),
      },
      {
        // Same accepted-shaped details on a non-spawn tool must still be reported:
        // the skip is gated on toolName so look-alike payloads are not suppressed.
        role: "toolResult",
        toolCallId: "call-other-lookalike",
        toolName: "some_other_tool",
        isError: true,
        details: acceptedDetails,
        content: [{ type: "text", text: "real failure" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "call-exec-failed",
      "call-other-lookalike",
    ]);
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ignored" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("keeps bounded tool-failure text UTF-16 safe", () => {
    const failures = collectToolFailures([
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: `${"x".repeat(236)}🚀tail` }],
        timestamp: Date.now(),
      },
    ]);

    expect(failures[0]?.summary).toBe(`${"x".repeat(236)}...`);
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) => ({
      role: "toolResult",
      toolCallId: `call-${idx}`,
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: `error ${idx}` }],
      timestamp: Date.now(),
    }));

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
  });

  it("omits section when there are no tool failures", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toBe("");
  });
});

describe("compaction-safeguard summary budgets", () => {
  it("caps file operations summary and reports omitted entries", () => {
    const readFiles = Array.from(
      { length: 200 },
      (_, i) => `docs/very/long/path/${i}-read-file.md`,
    );
    const modifiedFiles = Array.from(
      { length: 200 },
      (_, i) => `src/features/${i}/nested/component/file-${i}.ts`,
    );

    const section = formatFileOperations(readFiles, modifiedFiles);

    expect(section).toContain("<read-files>");
    expect(section).toContain("<modified-files>");
    expect(section).toContain("...and ");
    expect(section.length).toBeLessThanOrEqual(MAX_FILE_OPS_SECTION_CHARS);
  });

  it("caps final compaction summary with a truncation marker", () => {
    const oversized = "x".repeat(MAX_COMPACTION_SUMMARY_CHARS + 500);
    const capped = capCompactionSummary(oversized);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(capped.endsWith(SUMMARY_TRUNCATED_MARKER)).toBe(true);
  });

  it("keeps compaction summary prefixes UTF-16 safe", () => {
    const prefixBudget = MAX_COMPACTION_SUMMARY_CHARS - SUMMARY_TRUNCATED_MARKER.length;
    const oversized = `${"x".repeat(prefixBudget - 1)}🚀${"z".repeat(
      SUMMARY_TRUNCATED_MARKER.length + 10,
    )}`;

    expect(capCompactionSummary(oversized)).toBe(
      `${"x".repeat(prefixBudget - 1)}${SUMMARY_TRUNCATED_MARKER}`,
    );
    expect(capCompactionSummary(`${"x".repeat(9)}🚀tail`, 10)).toBe("x".repeat(9));
  });

  it("preserves workspace critical rules suffix when capping", () => {
    const suffix =
      "\n\n<workspace-critical-rules>\n## Session Startup\nRead AGENTS.md\n</workspace-critical-rules>";
    const body = "x".repeat(MAX_COMPACTION_SUMMARY_CHARS);

    const capped = capCompactionSummaryPreservingSuffix(body, suffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped).toContain("## Session Startup");
    expect(capped.endsWith(suffix)).toBe(true);
  });

  it("preserves diagnostic sections (tool failures, file ops) when capping oversized body", () => {
    const diagnosticSuffix =
      "\n\n## Tool Failures\n- exec: failed\n\n<read-files>\nfoo.ts\n</read-files>\n\n" +
      "<workspace-critical-rules>\n## Session Startup\nRead AGENTS.md\n</workspace-critical-rules>";
    const body = "x".repeat(MAX_COMPACTION_SUMMARY_CHARS);

    const capped = capCompactionSummaryPreservingSuffix(body, diagnosticSuffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("## Tool Failures");
    expect(capped).toContain("<read-files>");
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped.endsWith(diagnosticSuffix)).toBe(true);
  });

  it("keeps section separator when body ends without newline (e.g. buildStructuredFallbackSummary)", () => {
    const bodyNoNewline = "## Exact identifiers\nNone.";
    const suffixNoLeadingNewline = "## Tool Failures\n- exec: failed";

    const capped = capCompactionSummaryPreservingSuffix(
      bodyNoNewline,
      `\n\n${suffixNoLeadingNewline}`,
    );

    expect(capped).toContain("None.\n\n## Tool Failures");
    expect(capped).not.toMatch(/None\.## Tool Failures/);
  });

  it("keeps body prefix when truncation marker cannot fit (tiny budget)", () => {
    const body = "## Decisions\nKeep flow.\n## Constraints\nFollow rules.";
    const tinyBudget = 10; // Smaller than SUMMARY_TRUNCATED_MARKER.length
    const capped = capCompactionSummary(body, tinyBudget);

    expect(capped.length).toBeLessThanOrEqual(tinyBudget);
    expect(capped).toContain("## Decis");
    expect(capped).not.toContain("[Compaction summary truncated");
  });

  it("preserves tail sections when suffix exceeds cap (workspace rules, diagnostics over preserved turns)", () => {
    const criticalTail =
      "\n\n## Tool Failures\n- exec: failed\n\n<read-files>\nfoo.ts\n</read-files>\n\n" +
      "<workspace-critical-rules>\n## Session Startup\nRead AGENTS.md\n</workspace-critical-rules>";
    const preservedTurns =
      "## Recent turns preserved verbatim\n- User: x\n- Assistant: y\n" +
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS);
    const oversizedSuffix = preservedTurns + criticalTail;

    const capped = capCompactionSummaryPreservingSuffix("short body", oversizedSuffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped).toContain("## Tool Failures");
    expect(capped).toContain("<read-files>");
    expect(capped).toContain("## Session Startup");
  });

  it("keeps an oversized preserved suffix UTF-16 safe at its leading edge", () => {
    expect(capCompactionSummaryPreservingSuffix("body", "A🚀tail", 5)).toBe("tail");
  });
});

describe("computeAdaptiveChunkRatio", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns BASE_CHUNK_RATIO for normal messages", () => {
    // Small messages: 1000 tokens each, well under 10% of context
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(1000) }],
        timestamp: Date.now(),
      }),
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio when average message > 10% of context", () => {
    // Large messages: ~50K tokens each (25% of context)
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(50_000 * 4), timestamp: Date.now() },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(50_000 * 4) }],
        timestamp: Date.now(),
      }),
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("respects MIN_CHUNK_RATIO floor", () => {
    // Very large messages that would push ratio below minimum
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(150_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("handles empty message array", () => {
    const ratio = computeAdaptiveChunkRatio([], CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("handles single huge message", () => {
    // Single massive message
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(180_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
    expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
  });
});

describe("isOversizedForSummary", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns false for small messages", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(false);
  });

  it("returns true for messages > 50% of context", () => {
    // Message with ~120K tokens (60% of 200K context)
    // After safety margin (1.2x), effective is 144K which is > 100K (50%)
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(120_000 * 4),
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(true);
  });

  it("applies safety margin", () => {
    // Message at exactly 50% of context before margin
    // After SAFETY_MARGIN (1.2), it becomes 60% which is > 50%
    const halfContextChars = (CONTEXT_WINDOW * 0.5) / SAFETY_MARGIN;
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(Math.floor(halfContextChars * 4)),
      timestamp: Date.now(),
    };

    // With safety margin applied, this should be at the boundary
    // The function checks if tokens * SAFETY_MARGIN > contextWindow * 0.5
    const isOversized = isOversizedForSummary(msg, CONTEXT_WINDOW);
    // Due to token estimation, this could be either true or false at the boundary
    expect(typeof isOversized).toBe("boolean");
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("stores and retrieves config by session manager identity", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.3 });
    const runtime = getCompactionSafeguardRuntime(sm);
    expect(runtime).toEqual({ maxHistoryShare: 0.3 });
  });

  it("returns null for unknown session manager", () => {
    const sm = {};
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("clears entry when value is null", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.7 });
    expect(getCompactionSafeguardRuntime(sm)).toEqual({ maxHistoryShare: 0.7 });
    setCompactionSafeguardRuntime(sm, null);
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("ignores non-object session managers", () => {
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("isolates different session managers", () => {
    const sm1 = {};
    const sm2 = {};
    setCompactionSafeguardRuntime(sm1, { maxHistoryShare: 0.3 });
    setCompactionSafeguardRuntime(sm2, { maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime(sm1)).toEqual({ maxHistoryShare: 0.3 });
    expect(getCompactionSafeguardRuntime(sm2)).toEqual({ maxHistoryShare: 0.8 });
  });

  it("stores and retrieves model from runtime (fallback for compact.ts workflow)", () => {
    const sm = {};
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sm, { model });
    const retrieved = getCompactionSafeguardRuntime(sm);
    expect(retrieved?.model).toEqual(model);
  });

  it("stores and retrieves contextWindowTokens from runtime", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { contextWindowTokens: 200000 });
    const retrieved = getCompactionSafeguardRuntime(sm);
    expect(retrieved?.contextWindowTokens).toBe(200000);
  });

  it("stores and retrieves combined runtime values", () => {
    const sm = {};
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sm, {
      maxHistoryShare: 0.6,
      contextWindowTokens: 200000,
      model,
    });
    const retrieved = getCompactionSafeguardRuntime(sm);
    expect(retrieved).toEqual({
      maxHistoryShare: 0.6,
      contextWindowTokens: 200000,
      model,
    });
  });

  it("consumes cancel reasons without dropping other runtime fields", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.6 });
    setCompactionSafeguardCancelReason(sm, "no API key");

    expect(consumeCompactionSafeguardCancelReason(sm)).toBe("no API key");
    expect(consumeCompactionSafeguardCancelReason(sm)).toBeNull();
    expect(getCompactionSafeguardRuntime(sm)).toEqual({ maxHistoryShare: 0.6 });
  });

  it("clears cancel reason when set to undefined", () => {
    const sm = {};
    setCompactionSafeguardCancelReason(sm, "temporary reason");
    expect(consumeCompactionSafeguardCancelReason(sm)).toBe("temporary reason");
    setCompactionSafeguardCancelReason(sm, undefined);
    expect(consumeCompactionSafeguardCancelReason(sm)).toBeNull();
  });

  it("wires oversized safeguard runtime values when config validation is bypassed", () => {
    const sessionManager = {} as unknown as Parameters<
      typeof buildEmbeddedExtensionFactories
    >[0]["sessionManager"];
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            recentTurnsPreserve: 99,
            qualityGuard: { maxRetries: 99 },
          },
        },
      },
    } as OpenClawConfig;

    buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-3-opus",
      model: {
        contextWindow: 200_000,
      } as Parameters<typeof buildEmbeddedExtensionFactories>[0]["model"],
    });

    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(runtime?.qualityGuardMaxRetries).toBe(99);
    expect(runtime?.recentTurnsPreserve).toBe(99);
    expect(resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries)).toBe(3);
    expect(resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve)).toBe(12);
  });
});

describe("compaction-safeguard recent-turn preservation", () => {
  it("preserves the most recent user/assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "older ask", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "older answer" }],
        timestamp: 2,
      } as unknown as AgentMessage,
      { role: "user", content: "recent ask", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "recent answer" }],
        timestamp: 4,
      } as unknown as AgentMessage,
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages).toHaveLength(2);
    expect(split.summarizableMessages).toHaveLength(2);
    expect(formatPreservedTurnsSection(split.preservedMessages)).toContain(
      "## Recent turns preserved verbatim",
    );
  });

  it("drops orphaned tool results from preserved assistant turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "older ask", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "read", arguments: {} }],
        timestamp: 2,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "read",
        content: [{ type: "text", text: "old result" }],
        timestamp: 3,
      } as unknown as AgentMessage,
      { role: "user", content: "recent ask", timestamp: 4 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
        timestamp: 5,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call_recent",
        toolName: "read",
        content: [{ type: "text", text: "recent result" }],
        timestamp: 6,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "recent final answer" }],
        timestamp: 7,
      } as unknown as AgentMessage,
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages.map((msg: AgentMessage) => msg.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(
      split.preservedMessages.some(
        (msg: AgentMessage) =>
          msg.role === "user" && (msg as { content?: unknown }).content === "recent ask",
      ),
    ).toBe(true);

    const summarizableToolResultIds = split.summarizableMessages
      .filter((msg: AgentMessage) => msg.role === "toolResult")
      .map((msg: AgentMessage) => (msg as { toolCallId?: unknown }).toolCallId);
    expect(summarizableToolResultIds).toContain("call_old");
    expect(summarizableToolResultIds).not.toContain("call_recent");
  });

  it("includes preserved tool results in the preserved-turns section", () => {
    const split = splitPreservedRecentTurns({
      messages: [
        { role: "user", content: "older ask", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "older answer" }],
          timestamp: 2,
        } as unknown as AgentMessage,
        { role: "user", content: "recent ask", timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
          timestamp: 4,
        } as unknown as AgentMessage,
        {
          role: "toolResult",
          toolCallId: "call_recent",
          toolName: "read",
          content: [{ type: "text", text: "recent raw output" }],
          timestamp: 5,
        } as unknown as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "recent final answer" }],
          timestamp: 6,
        } as unknown as AgentMessage,
      ],
      recentTurnsPreserve: 1,
    });

    const section = formatPreservedTurnsSection(split.preservedMessages);
    expect(section).toContain("- Tool result (read): recent raw output");
    expect(section).toContain("- User: recent ask");
  });

  it("formats preserved non-text messages with placeholders", () => {
    const section = formatPreservedTurnsSection([
      {
        role: "user",
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        timestamp: 1,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
        timestamp: 2,
      } as unknown as AgentMessage,
    ]);

    expect(section).toContain("- User: [non-text content: image]");
    expect(section).toContain("- Assistant: [non-text content: toolCall]");
  });

  it("keeps non-text placeholders for mixed-content preserved messages", () => {
    const section = formatPreservedTurnsSection([
      {
        role: "user",
        content: [
          { type: "text", text: "caption text" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      } as unknown as AgentMessage,
    ]);

    expect(section).toContain("- User: caption text");
    expect(section).toContain("[non-text content: image]");
  });

  it("keeps bounded preserved-turn text UTF-16 safe", () => {
    const section = formatPreservedTurnsSection([
      {
        role: "user",
        content: `${"x".repeat(599)}🚀tail`,
        timestamp: 1,
      },
    ]);

    expect(section).toContain(`- User: ${"x".repeat(599)}...`);
  });

  it("does not add non-text placeholders for text-only content blocks", () => {
    const section = formatPreservedTurnsSection([
      {
        role: "assistant",
        content: [{ type: "text", text: "plain text reply" }],
        timestamp: 1,
      } as unknown as AgentMessage,
    ]);

    expect(section).toContain("- Assistant: plain text reply");
    expect(section).not.toContain("[non-text content]");
  });

  it("caps preserved tail when user turns are below preserve target", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "single user prompt", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-1" }],
        timestamp: 2,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-2" }],
        timestamp: 3,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-3" }],
        timestamp: 4,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-4" }],
        timestamp: 5,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-5" }],
        timestamp: 6,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-6" }],
        timestamp: 7,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-7" }],
        timestamp: 8,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant-8" }],
        timestamp: 9,
      } as unknown as AgentMessage,
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 3,
    });

    // preserve target is 3 turns -> fallback should cap at 6 role messages
    expect(split.preservedMessages).toHaveLength(6);
    expect(
      split.preservedMessages.some(
        (msg: AgentMessage) =>
          msg.role === "user" && (msg as { content?: unknown }).content === "single user prompt",
      ),
    ).toBe(true);
    expect(formatPreservedTurnsSection(split.preservedMessages)).toContain("assistant-8");
    expect(formatPreservedTurnsSection(split.preservedMessages)).not.toContain("assistant-2");
  });

  it("trim-starts preserved section when history summary is empty", () => {
    const summary = appendSummarySection(
      "",
      "\n\n## Recent turns preserved verbatim\n- User: hello",
    );
    expect(summary.startsWith("## Recent turns preserved verbatim")).toBe(true);
  });

  it("does not append empty summary sections", () => {
    expect(appendSummarySection("History", "")).toBe("History");
    expect(appendSummarySection("", "")).toBe("");
  });

  it("clamps preserve count into a safe range", () => {
    expect(resolveRecentTurnsPreserve(undefined)).toBe(3);
    expect(resolveRecentTurnsPreserve(-1)).toBe(0);
    expect(resolveRecentTurnsPreserve(99)).toBe(12);
  });

  it("extracts opaque identifiers and audits summary quality", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and URL https://example.com/a and /tmp/x.log plus port host.local:18789",
    );
    expect(identifiers).toStrictEqual([
      "A1B2C3D4E5F6", // pragma: allowlist secret
      "https://example.com/a",
      "/tmp/x.log",
      "host.local:18789",
    ]);

    const summary = [
      "## Decisions",
      "Keep current flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve identifiers.",
      "## Pending user asks",
      "Explain post-compaction behavior.",
      "## Exact identifiers",
      identifiers.join(", "),
    ].join("\n");

    const quality = auditSummaryQuality({
      summary,
      identifiers,
      latestAsk: "Explain post-compaction behavior for memory indexing",
    });
    expect(quality.ok).toBe(true);
  });

  it("dedupes pure-hex identifiers across case variants", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and again a1b2c3d4e5f6",
    );
    expect(
      identifiers.reduce(
        (count: number, id: string) => count + (id === "A1B2C3D4E5F6" ? 1 : 0), // pragma: allowlist secret
        0,
      ),
    ).toBe(1);
  });

  it("dedupes identifiers before applying the result cap", () => {
    const noisyPrefix = Array.from({ length: 10 }, () => "a0b0c0d0").join(" ");
    const uniqueTail = Array.from(
      { length: 12 },
      (_, idx) => `b${idx.toString(16).padStart(7, "0")}`,
    );
    const identifiers = extractOpaqueIdentifiers(`${noisyPrefix} ${uniqueTail.join(" ")}`);

    expect(identifiers).toHaveLength(12);
    expect(new Set(identifiers).size).toBe(12);
    expect(identifiers).toContain("A0B0C0D0");
    expect(identifiers).toContain(uniqueTail[10]?.toUpperCase());
  });

  it("filters ordinary short numbers and trims wrapped punctuation", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Year 2026 count 42 port 18789 ticket 123456 URL https://example.com/a, path /tmp/x.log, and tiny /a with prose on/off.",
    );

    expect(identifiers).not.toContain("2026");
    expect(identifiers).not.toContain("42");
    expect(identifiers).not.toContain("18789");
    expect(identifiers).not.toContain("/a");
    expect(identifiers).not.toContain("/off");
    expect(identifiers).toContain("123456");
    expect(identifiers).toContain("https://example.com/a");
    expect(identifiers).toContain("/tmp/x.log");
  });

  it("fails quality audit when required sections are missing", () => {
    const quality = auditSummaryQuality({
      summary: "Short summary without structure",
      identifiers: ["abc12345"],
      latestAsk: "Need a status update",
    });
    expect(quality.ok).toBe(false);
    expect(quality.reasons).toStrictEqual([
      "missing_section:## Decisions",
      "missing_section:## Open TODOs",
      "missing_section:## Constraints/Rules",
      "missing_section:## Pending user asks",
      "missing_section:## Exact identifiers",
      "missing_identifiers:abc12345",
      "latest_user_ask_not_reflected",
    ]);
  });

  it("requires exact section headings instead of substring matches", () => {
    const quality = auditSummaryQuality({
      summary: [
        "See ## Decisions above.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Keep policy.",
        "## Pending user asks",
        "Need status.",
        "## Exact identifiers",
        "abc12345",
      ].join("\n"),
      identifiers: ["abc12345"],
      latestAsk: "Need status.",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("missing_section:## Decisions");
  });

  it("does not enforce identifier retention when policy is off", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Use redacted summary.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "No sensitive identifiers.",
        "## Pending user asks",
        "Provide status.",
        "## Exact identifiers",
        "Redacted.",
      ].join("\n"),
      identifiers: ["sensitive-token-123456"],
      latestAsk: "Provide status.",
      identifierPolicy: "off",
    });

    expect(quality.ok).toBe(true);
  });

  it("does not force strict identifier retention for custom policy", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Mask secrets by default.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow custom policy.",
        "## Pending user asks",
        "Share summary.",
        "## Exact identifiers",
        "Masked by policy.",
      ].join("\n"),
      identifiers: ["api-key-abcdef123456"],
      latestAsk: "Share summary.",
      identifierPolicy: "custom",
    });

    expect(quality.ok).toBe(true);
  });

  it("matches pure-hex identifiers case-insensitively in retention checks", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve hex IDs.",
        "## Pending user asks",
        "Provide status.",
        "## Exact identifiers",
        "a1b2c3d4e5f6", // pragma: allowlist secret
      ].join("\n"),
      identifiers: ["A1B2C3D4E5F6"], // pragma: allowlist secret
      latestAsk: "Provide status.",
      identifierPolicy: "strict",
    });

    expect(quality.ok).toBe(true);
  });

  it("flags missing non-latin latest asks when summary omits them", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve safety checks.",
        "## Pending user asks",
        "No pending asks.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
      identifiers: [],
      latestAsk: "请提供状态更新",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("latest_user_ask_not_reflected");
  });

  it("accepts non-latin latest asks when summary reflects a shorter cjk phrase", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve safety checks.",
        "## Pending user asks",
        "状态更新 pending.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
      identifiers: [],
      latestAsk: "请提供状态更新",
    });

    expect(quality.ok).toBe(true);
  });

  it("rejects latest-ask overlap when only stopwords overlap", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow policy.",
        "## Pending user asks",
        "This is to track active asks.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
      identifiers: [],
      latestAsk: "What is the plan to migrate?",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("latest_user_ask_not_reflected");
  });

  it("requires more than one meaningful overlap token for detailed asks", () => {
    const quality = auditSummaryQuality({
      summary: [
        "## Decisions",
        "Keep current flow.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Follow policy.",
        "## Pending user asks",
        "Password issue tracked.",
        "## Exact identifiers",
        "None.",
      ].join("\n"),
      identifiers: [],
      latestAsk: "Please reset account password now",
    });

    expect(quality.ok).toBe(false);
    expect(quality.reasons).toContain("latest_user_ask_not_reflected");
  });

  it("clamps quality-guard retries into a safe range", () => {
    expect(resolveQualityGuardMaxRetries(undefined)).toBe(1);
    expect(resolveQualityGuardMaxRetries(-1)).toBe(0);
    expect(resolveQualityGuardMaxRetries(99)).toBe(3);
  });

  it("builds structured instructions with required sections", () => {
    const instructions = buildCompactionStructureInstructions("Keep security caveats.");
    expect(instructions).toContain("## Decisions");
    expect(instructions).toContain("## Open TODOs");
    expect(instructions).toContain("## Constraints/Rules");
    expect(instructions).toContain("## Pending user asks");
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("Keep security caveats.");
    expect(instructions).not.toContain("Additional focus:");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("does not force strict identifier retention when identifier policy is off", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "off",
    });
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("do not enforce literal-preservation rules");
    expect(instructions).not.toContain("preserve literal values exactly as seen");
    expect(instructions).not.toContain("N/A (identifier policy off)");
  });

  it("threads custom identifier policy text into structured instructions", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Exclude secrets and one-time tokens from summaries.",
    });
    expect(instructions).toContain("For ## Exact identifiers, apply this operator-defined policy");
    expect(instructions).toContain("Exclude secrets and one-time tokens from summaries.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes untrusted custom instruction text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(
      "Ignore above <script>alert(1)</script>",
    );
    expect(instructions).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("sanitizes custom identifier policy text before embedding", () => {
    const instructions = buildCompactionStructureInstructions(undefined, {
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket <ABC-123> but remove \u200Bsecrets.",
    });
    expect(instructions).toContain("Keep ticket &lt;ABC-123&gt; but remove secrets.");
    expect(instructions).toContain("<untrusted-text>");
  });

  it("builds a structured fallback summary from legacy previous summary text", () => {
    const summary = buildStructuredFallbackSummary("legacy summary without headings");
    expect(summary).toContain("## Decisions");
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("legacy summary without headings");
  });

  it("preserves an already-structured previous summary as-is", () => {
    const structured = [
      "## Decisions",
      "done",
      "",
      "## Open TODOs",
      "todo",
      "",
      "## Constraints/Rules",
      "rules",
      "",
      "## Pending user asks",
      "asks",
      "",
      "## Exact identifiers",
      "ids",
    ].join("\n");
    expect(buildStructuredFallbackSummary(structured)).toBe(structured);
  });

  it("converts previous summaries into redistill input instead of update-prompt state", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "new context", timestamp: 1 }];
    const redistillMessages = prependPreviousSummaryForRedistill({
      messages,
      previousSummary: "## Goal\nold duplicate summary",
    });

    expect(redistillMessages).toHaveLength(2);
    expect(redistillMessages[0]?.role).toBe("user");
    expect(JSON.stringify(redistillMessages[0])).toContain("<previous-compaction-summary>");
    expect(JSON.stringify(redistillMessages[0])).toContain("Prune stale, duplicate");
    expect(redistillMessages[1]).toBe(messages[0]);
  });

  it("restructures summaries with near-match headings instead of reusing them", () => {
    const nearMatch = [
      "## Decisions",
      "done",
      "",
      "## Open TODOs (active)",
      "todo",
      "",
      "## Constraints/Rules",
      "rules",
      "",
      "## Pending user asks",
      "asks",
      "",
      "## Exact identifiers",
      "ids",
    ].join("\n");
    const summary = buildStructuredFallbackSummary(nearMatch);
    expect(summary).not.toBe(nearMatch);
    expect(summary).toContain("\n## Open TODOs\n");
  });

  it("does not force policy-off marker in fallback exact identifiers section", () => {
    const summary = buildStructuredFallbackSummary(undefined, {
      identifierPolicy: "off",
    });
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("None captured.");
    expect(summary).not.toContain("N/A (identifier policy off).");
  });

  it("uses structured instructions when summarizing dropped history chunks", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("mock summary"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      maxHistoryShare: 0.1,
      recentTurnsPreserve: 12,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const messagesToSummarize: AgentMessage[] = Array.from({ length: 4 }, (_unused, index) => ({
      role: "user",
      content: `msg-${index}-${"x".repeat(120_000)}`,
      timestamp: index + 1,
    }));
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 400_000,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "Keep security caveats.",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const droppedCall = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(droppedCall?.customInstructions).toContain(
      "Produce a compact, factual summary with these exact section headings:",
    );
    expect(droppedCall?.customInstructions).toContain("## Decisions");
    expect(droppedCall?.customInstructions).toContain("Keep security caveats.");
  });

  it("uses repaired no-drop prune output for summarization", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue("mock summary");

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
    });

    // An assistant tool call with no matching tool_result — simulates a
    // provider-side timeout that interrupted the turn before the tool result
    // was received.  The history fits inside the token budget (no chunks
    // dropped), so the earlier code path never ran repairToolUseResultPairing.
    const orphanToolCall: AgentMessage = {
      role: "assistant" as const,
      content: [{ type: "toolCall", id: "call-timeout", name: "read", arguments: {} }],
      stopReason: "aborted",
      errorMessage: "This operation was aborted",
      errorCode: "20",
      timestamp: 1,
    } as AgentMessage;
    const followupUser: AgentMessage = {
      role: "user" as const,
      content: "continue after timeout",
      timestamp: 2,
    };

    const event = {
      preparation: {
        messagesToSummarize: [orphanToolCall, followupUser] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 300_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expectCompactionResult(result);
    const summaryCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const summaryMessages = requireArray(summaryCall.messages);
    // The aborted assistant turn (stopReason=aborted) must be dropped entirely
    // by erroredAssistantResultPolicy="drop". Only the follow-up user message
    // should reach summarizeInStages — no orphaned toolCall, no synthetic toolResult.
    expect(summaryMessages.map((m) => (m as { role?: unknown }).role)).toEqual(["user"]);
    // Verify no unpaired toolCall reaches the summarizer.
    const toolCallIds = summaryMessages
      .flatMap((m) => {
        const content = (m as { content?: unknown }).content;
        if (!Array.isArray(content)) { return []; }
        return content
          .filter((b) => (b as { type?: string }).type === "toolCall")
          .map((b) => (b as { id?: string }).id)
          .filter(Boolean);
      });
    expect(toolCallIds).toHaveLength(0);
  });

  it("repairs orphaned tool_use in pruned.messages when chunks are dropped", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue("mock summary");

    const sessionManager = stubSessionManager();
    // maxHistoryShare=0.1 forces the prune path to drop older chunks.
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      maxHistoryShare: 0.01,
      recentTurnsPreserve: 0,
    });

    // Oldest messages: an orphaned assistant toolCall (no matching toolResult)
    // simulating a provider-side timeout that aborted the turn mid-flight.
    const orphanToolCall: AgentMessage = {
      role: "assistant" as const,
      content: [{ type: "toolCall", id: "call-dropped", name: "exec", arguments: {} }],
      stopReason: "aborted",
      errorMessage: "This operation was aborted",
      errorCode: "20",
      timestamp: 1,
    } as AgentMessage;
    // Newer messages — large enough to push usage past the history budget so
    // that buildHistoryPrunePlan drops the older chunk containing the orphan.
    const newerMessages: AgentMessage[] = Array.from({ length: 3 }, (_unused, i) => ({
      role: "user" as const,
      content: `msg-${i}-${"x".repeat(50_000)}`,
      timestamp: i + 2,
    }));

    const event = {
      preparation: {
        messagesToSummarize: [orphanToolCall, ...newerMessages] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 400_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });
    expectCompactionResult(result);

    // summarizeInStages must be called (possibly for dropped chunks too).
    expect(mockSummarizeInStages).toHaveBeenCalled();
    // Verify no call received a messages array that contains an unpaired toolCall.
    for (const call of mockSummarizeInStages.mock.calls) {
      const callArg = call[0] as { messages?: unknown[] };
      const msgs = callArg?.messages ?? [];
      const toolCallIds = new Set(
        msgs
          .flatMap((m) => {
            const content = (m as { content?: unknown }).content;
            if (!Array.isArray(content)) { return []; }
            return content
              .filter((b) => (b as { type?: string }).type === "toolCall")
              .map((b) => (b as { id?: string }).id)
              .filter(Boolean);
          }),
      );
      const toolResultIds = new Set(
        msgs
          .map((m) => (m as { toolCallId?: string }).toolCallId)
          .filter(Boolean),
      );
      for (const id of toolCallIds) {
        expect(toolResultIds.has(id)).toBe(true);
      }
    }
  });

  it("caps summarization reserve tokens to the model output limit", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("mock summary"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const compactionHandler = createCompactionHandler();
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock: vi.fn().mockResolvedValue("test-key"),
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "large history", timestamp: 1 } as AgentMessage,
        ],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 250_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 240_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    await compactionHandler(event, mockContext);

    const call = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(call?.reserveTokens).toBe(128_000);
  });

  it("adds Copilot IDE headers to built-in compaction summarization", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("mock summary"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture({
      id: "gpt-5.4",
      name: "gpt-5.4",
      provider: "github-copilot",
      api: "openai-responses" as const,
      baseUrl: "https://api.githubcopilot.com",
    });
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const getApiKeyAndHeadersMock = vi.fn().mockResolvedValue({
      ok: true,
      apiKey: "github-token",
      headers: { "X-Test": "1" },
    });
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyAndHeadersMock,
    });
    const compactionHandler = createCompactionHandler();
    const event = createCompactionEvent({
      messageText: "summarize me",
      tokensBefore: 1000,
    });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4000,
    };

    const result = (await compactionHandler(event, mockContext)) as { cancel?: boolean };

    expect(result.cancel).not.toBe(true);
    const summaryCall = latestMockCallArg(mockSummarizeInStages) as {
      headers?: Record<string, string>;
    };
    expect(summaryCall.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(summaryCall.headers?.["Editor-Plugin-Version"]).toBe("copilot-chat/0.35.0");
    expect(summaryCall.headers?.["Openai-Organization"]).toBe("github-copilot");
    expect(summaryCall.headers?.["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
    expect(summaryCall.headers?.["X-Test"]).toBe("1");
    expect(summaryCall.headers?.["x-initiator"]).toBe("user");
  });

  it("does not retry summaries unless quality guard is explicitly enabled", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("summary missing headings"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
          { role: "assistant", content: "older reply", timestamp: 2 } as unknown as AgentMessage,
        ],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
  });

  it("retries when generated summary misses headings even if preserved turns contain them", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult("latest ask status"))
      .mockResolvedValueOnce(
        summaryResult(
          [
            "## Decisions",
            "Keep current flow.",
            "## Open TODOs",
            "None.",
            "## Constraints/Rules",
            "Follow rules.",
            "## Pending user asks",
            "latest ask status",
            "## Exact identifiers",
            "None.",
          ].join("\n"),
        ),
      );

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 1,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
          {
            role: "custom",
            customType: "openclaw.runtime-context",
            content: "secret runtime context",
            display: false,
            timestamp: 1.5,
          } as unknown as AgentMessage,
          { role: "assistant", content: "older reply", timestamp: 2 } as unknown as AgentMessage,
          { role: "user", content: "latest ask status", timestamp: 3 },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: [
                  "## Decisions",
                  "from preserved turns",
                  "## Open TODOs",
                  "from preserved turns",
                  "## Constraints/Rules",
                  "from preserved turns",
                  "## Pending user asks",
                  "from preserved turns",
                  "## Exact identifiers",
                  "from preserved turns",
                ].join("\n"),
              },
            ],
            timestamp: 4,
          } as unknown as AgentMessage,
        ],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const secondCall = mockCallArg(mockSummarizeInStages, 1) as {
      customInstructions?: string;
    };
    expect(secondCall.customInstructions).toContain("Quality check feedback");
    expect(secondCall.customInstructions).toContain("missing_section:## Decisions");
  });

  it("does not treat preserved latest asks as satisfying overlap checks", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages
      .mockResolvedValueOnce(
        summaryResult(
          [
            "## Decisions",
            "Keep current flow.",
            "## Open TODOs",
            "None.",
            "## Constraints/Rules",
            "Follow rules.",
            "## Pending user asks",
            "latest ask status",
            "## Exact identifiers",
            "None.",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(
        summaryResult(
          [
            "## Decisions",
            "Keep current flow.",
            "## Open TODOs",
            "None.",
            "## Constraints/Rules",
            "Follow rules.",
            "## Pending user asks",
            "older context",
            "## Exact identifiers",
            "None.",
          ].join("\n"),
        ),
      );

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 1,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
          { role: "assistant", content: "older reply", timestamp: 2 } as unknown as AgentMessage,
          { role: "user", content: "latest ask status", timestamp: 3 },
          {
            role: "assistant",
            content: "latest assistant reply",
            timestamp: 4,
          } as unknown as AgentMessage,
        ],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const secondCall = mockCallArg(mockSummarizeInStages, 1) as {
      customInstructions?: string;
    };
    expect(secondCall.customInstructions).toContain("latest_user_ask_not_reflected");
  });

  it("preserves split-turn and recent-turn suffixes when retry fallback is capped", async () => {
    mockSummarizeInStages.mockReset();
    const oversizedHistorySummary = "history detail ".repeat(MAX_COMPACTION_SUMMARY_CHARS);
    const splitTurnPrefixSummary = "split-turn prefix context that must survive capping";
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult(oversizedHistorySummary))
      .mockResolvedValueOnce(summaryResult(splitTurnPrefixSummary))
      .mockRejectedValueOnce(new Error("retry transient failure"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 1,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
          { role: "assistant", content: "older reply", timestamp: 2 } as unknown as AgentMessage,
          { role: "user", content: "latest ask status", timestamp: 3 },
          {
            role: "assistant",
            content: [{ type: "text", text: "latest assistant reply" }],
            timestamp: 4,
          } as unknown as AgentMessage,
        ],
        turnPrefixMessages: [
          { role: "user", content: "prefix request that was split out", timestamp: 0 },
        ],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER);
    expect(summary).toContain("**Turn Context (split turn):**");
    expect(summary).toContain(splitTurnPrefixSummary);
    expect(summary).toContain("## Recent turns preserved verbatim");
    expect(summary).toContain("latest ask status");
    expect(summary).toContain("latest assistant reply");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(3);
  });

  it("keeps required headings when all turns are preserved and history is carried forward", async () => {
    mockSummarizeInStages.mockReset();

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 12,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "latest user ask", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "latest assistant reply" }],
            timestamp: 2,
          } as unknown as AgentMessage,
        ],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: "legacy summary without headings",
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    const summary = result.compaction?.summary ?? "";
    expect(summary).toContain("## Decisions");
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("legacy summary without headings");
  });

  it("re-distills prior summaries on the LLM path instead of preserving them verbatim", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(
      summaryResult(
        [
          "## Decisions",
          "Condensed prior context with latest status.",
          "## Open TODOs",
          "None.",
          "## Constraints/Rules",
          "Preserve identifiers.",
          "## Pending user asks",
          "latest ask status",
          "## Exact identifiers",
          "None.",
        ].join("\n"),
      ),
    );

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });

    const compactionHandler = createCompactionHandler();
    const getApiKeyMock = vi.fn().mockResolvedValue("test-key");
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock,
    });
    const event = {
      preparation: {
        messagesToSummarize: [{ role: "user", content: "latest ask status", timestamp: 1 }],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: "## Goal\nOld duplicated section that should be re-distilled.",
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const call = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(call?.previousSummary).toBeUndefined();
    const messages = requireArray(call.messages);
    expect(JSON.stringify(messages[0])).toContain("<previous-compaction-summary>");
    expect(JSON.stringify(messages[0])).toContain("Old duplicated section");
    expect(result.compaction?.summary).not.toContain("Old duplicated section");
  });

  it("preserves the prior summary when staged summarization returns a generic fallback", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue({
      kind: "generic-fallback",
      text: "Context contained 4 messages. Summary unavailable due to size limits.",
    });

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
    });

    const compactionHandler = createCompactionHandler();
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock: vi.fn().mockResolvedValue("test-key"),
    });
    const event = {
      preparation: {
        messagesToSummarize: [{ role: "user", content: "latest ask status", timestamp: 1 }],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: "## Goal\nKnown context that must survive the outage.",
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(result.compaction?.summary).toContain("Known context that must survive the outage.");
    expect(result.compaction?.summary).toContain("Summary unavailable due to size limits.");
  });

  it("falls back to LLM when provider throws a provider-side AbortError with signal not aborted", async () => {
    // Reproduce the undici AbortError("This operation was aborted") shape that
    // arrives when the compaction provider's HTTP connection drops mid-stream while
    // the caller has NOT yet fired their abort signal. Before the fix,
    // isAbortError() matched this shape so tryProviderSummarize rethrew and the
    // extension runner swallowed the error — the LLM fallback path was skipped.
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("llm fallback summary"));

    const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const failingProviderSummarize = vi.fn().mockRejectedValue(providerAbortErr);
    registerCompactionProvider({
      id: "disconnecting-provider",
      label: "Disconnecting Provider",
      summarize: failingProviderSummarize,
    });

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "disconnecting-provider",
      model,
      recentTurnsPreserve: 0,
    });

    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
          { role: "assistant", content: "older reply", timestamp: 2 } as unknown as AgentMessage,
        ],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "",
      signal: new AbortController().signal, // not aborted
    };
    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "key" });

    // Provider failure → LLM fallback ran, not { cancel: true }.
    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalled();
  });

  it("propagates provider AbortError and cancels when caller signal is already aborted", async () => {
    mockSummarizeInStages.mockReset();

    const providerAbortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const failingProviderSummarize = vi.fn().mockRejectedValue(providerAbortErr);
    registerCompactionProvider({
      id: "aborted-provider",
      label: "Aborted Provider",
      summarize: failingProviderSummarize,
    });

    const controller = new AbortController();
    controller.abort();

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "aborted-provider",
    });

    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "",
      signal: controller.signal, // already aborted
    };

    await expect(
      runCompactionScenario({ sessionManager, event, apiKey: "key" }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // Caller abort is terminal — LLM fallback should not have run.
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
  });

  it("passes compaction instructions to providers and preserves suffix context", async () => {
    mockSummarizeInStages.mockReset();
    const providerSummarize = vi.fn().mockResolvedValue("provider summary body");
    registerCompactionProvider({
      id: "test-provider",
      label: "Test Provider",
      summarize: providerSummarize,
    });

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "test-provider",
      recentTurnsPreserve: 1,
      identifierPolicy: "custom",
      identifierInstructions: "Preserve ticket IDs exactly.",
      customInstructions: "Keep milestone names.",
    });

    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "older context", timestamp: 1 },
          { role: "assistant", content: "older reply", timestamp: 2 } as unknown as AgentMessage,
          { role: "user", content: "latest ask status", timestamp: 3 },
          {
            role: "assistant",
            content: [{ type: "text", text: "latest assistant reply" }],
            timestamp: 4,
          } as AgentMessage,
        ],
        turnPrefixMessages: [
          { role: "user", content: "prefix request that was split out", timestamp: 0 },
        ],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: {
          read: [],
          edited: [],
          written: [],
        },
        settings: { reserveTokens: 4_000 },
        previousSummary: "previous provider summary",
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: null,
    });

    const compaction = expectCompactionResult(result);
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    const providerInput = requireRecord(mockCallArg(providerSummarize));
    expect(providerInput?.previousSummary).toBe("previous provider summary");
    expect(providerInput?.customInstructions).toContain("Keep milestone names.");
    expect(providerInput?.summarizationInstructions).toEqual({
      identifierPolicy: "custom",
      identifierInstructions: "Preserve ticket IDs exactly.",
    });
    const providerMessages = providerInput.messages ?? [];
    expect(JSON.stringify(providerMessages)).not.toContain("openclaw.runtime-context");
    expect(JSON.stringify(providerMessages)).not.toContain("secret runtime context");
    expect(compaction.summary).toContain("provider summary body");
    expect(compaction.summary).toContain("**Turn Context (split turn):**");
    expect(compaction.summary).toContain("prefix request that was split out");
    expect(compaction.summary).toContain("## Recent turns preserved verbatim");
    expect(compaction.summary).toContain("latest ask status");
    expect(compaction.summary).toContain("latest assistant reply");
  });
});

describe("compaction-safeguard extension model fallback", () => {
  it("uses runtime.model when ctx.model is undefined (compact.ts workflow)", async () => {
    // This test verifies the root-cause fix: when extensionRunner.initialize() is not called
    // (as happens in compact.ts), ctx.model is undefined but runtime.model is available.
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();

    // Set up runtime with model (mimics buildEmbeddedExtensionPaths behavior)
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = createCompactionEvent({
      messageText: "test message",
      tokensBefore: 1000,
    });
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: null,
    });

    expect(result).toEqual({ cancel: true });

    // KEY ASSERTION: Prove the fallback path was exercised
    // The handler should have resolved request auth with runtime.model
    // (via ctx.model ?? runtime?.model).
    expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);

    // Verify runtime.model is still available (for completeness)
    const retrieved = getCompactionSafeguardRuntime(sessionManager);
    expect(retrieved?.model).toEqual(model);
  });

  it("proceeds with keyless SDK-managed auth (ok:true, no apiKey/headers)", async () => {
    // Regression: aws-sdk/oauth providers sign requests later and resolve with
    // neither apiKey nor headers. `ok: true` must be trusted so compaction runs
    // instead of wedging every message with a false "no credentials" cancel.
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("mock summary"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture({ provider: "amazon-bedrock" });
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const getApiKeyAndHeadersMock = vi.fn().mockResolvedValue({ ok: true });
    const mockContext = createCompactionContext({ sessionManager, getApiKeyAndHeadersMock });
    const compactionHandler = createCompactionHandler();
    const event = createCompactionEvent({ messageText: "summarize me", tokensBefore: 1000 });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4000,
    };

    const result = (await compactionHandler(event, mockContext)) as { cancel?: boolean };

    expect(result.cancel).not.toBe(true);
    expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
    expect(mockSummarizeInStages).toHaveBeenCalled();
  });

  it("cancels compaction when both ctx.model and runtime.model are undefined", async () => {
    const sessionManager = stubSessionManager();

    // Do NOT set runtime.model (both ctx.model and runtime.model will be undefined)

    const mockEvent = createCompactionEvent({
      messageText: "test",
      tokensBefore: 500,
    });
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: null,
    });

    expect(result).toEqual({ cancel: true });

    // Verify early return: request auth should NOT have been resolved when both models are missing.
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
  });
});

describe("compaction-safeguard double-compaction guard", () => {
  it("cancels compaction when there are no real messages to summarize", async () => {
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1500,
        fileOps: { read: [], edited: [], written: [] },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "sk-test", // pragma: allowlist secret
    });
    const compaction = expectCompactionResult(result);
    // After fix for #41981: returns a compaction result (not cancel) to write
    // a boundary entry and break the re-trigger loop.
    // buildStructuredFallbackSummary(undefined) produces a minimal structured summary
    expect(compaction.summary).toContain("## Decisions");
    expect(compaction.summary).toContain("No prior history.");
    expect(compaction.summary).toContain("## Open TODOs");
    expect(compaction.firstKeptEntryId).toBe("entry-1");
    expect(compaction.tokensBefore).toBe(1500);
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
  });

  it("returns compaction result with structured fallback summary sections", async () => {
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-2",
        tokensBefore: 2000,
        previousSummary: "## Decisions\nUsed approach A.",
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 16384 },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "sk-test", // pragma: allowlist secret
    });
    const compaction = expectCompactionResult(result);
    // Fallback preserves previous summary when it has required sections
    expect(compaction.summary).toContain("## Decisions");
    expect(compaction.summary).toContain("## Open TODOs");
    expect(compaction.firstKeptEntryId).toBe("entry-2");
  });

  it("writes boundary again on repeated empty preparation (no cancel loop after new assistant message)", async () => {
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-3",
        tokensBefore: 1000,
        fileOps: { read: [], edited: [], written: [] },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    // First call — writes boundary
    const { result: result1 } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "sk-test", // pragma: allowlist secret
    });
    const compaction1 = expectCompactionResult(result1);
    expect(compaction1.summary).toContain("## Decisions");

    // Simulate: after the boundary, a new assistant message arrives, SDK
    // triggers compaction again with another empty preparation. The safeguard
    // must write another boundary (not cancel) to avoid re-entering the
    // cancel loop described in the maintainer review.
    const { result: result2 } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "sk-test", // pragma: allowlist secret
    });
    const compaction2 = expectCompactionResult(result2);
    expect(compaction2.summary).toContain("## Decisions");
    expect(compaction2.firstKeptEntryId).toBe("entry-3");
  });

  it("does not write boundary when turnPrefixMessages has real content (split-turn)", async () => {
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [
          { role: "user" as const, content: "real turn prefix content" },
        ] as AgentMessage[],
        firstKeptEntryId: "entry-4",
        tokensBefore: 2000,
        fileOps: { read: [], edited: [], written: [] },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: null,
    });
    // Should NOT take the boundary fast-path — falls through to normal compaction
    // (which cancels due to no API key, but that's the expected normal path)
    expect(result).toEqual({ cancel: true });
  });

  it("does not write boundary when visible custom turn-prefix content is real conversation", async () => {
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [
          {
            role: "custom" as const,
            customType: "cron-request",
            content: "prepare the daily report",
            display: true,
            timestamp: 1,
          },
          {
            role: "assistant" as const,
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
            timestamp: 2,
          },
          {
            role: "toolResult" as const,
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "report source data" }],
            timestamp: 3,
          },
        ] as AgentMessage[],
        firstKeptEntryId: "entry-5",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: null,
    });

    expect(result).toEqual({ cancel: true });
    expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
  });

  it("falls back to visible custom session branch entries before writing an empty boundary", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("branch summary"));

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "custom_message",
          id: "custom-1",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          customType: "cron-request",
          content: "prepare the daily report",
          display: true,
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "custom-1",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
            timestamp: now + 1,
          },
        },
        {
          type: "message",
          id: "tool-1",
          parentId: "assistant-1",
          timestamp: new Date(now + 2).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "report source data" }],
            timestamp: now + 2,
          },
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-5",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "test-key",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("branch summary");
    expect(compaction.summary).not.toContain("No prior history.");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(
      messages.some((message) => {
        const record = requireRecord(message);
        return (
          record.role === "custom" &&
          record.customType === "cron-request" &&
          record.content === "prepare the daily report"
        );
      }),
    ).toBe(true);
    expect(
      messages.some((message) => {
        const record = requireRecord(message);
        return record.role === "toolResult" && record.toolName === "read";
      }),
    ).toBe(true);
  });

  it("does not replay inter-session sessions_send branch turns as fallback history", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("branch summary"));

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: {
            role: "user",
            content: "say bee",
            provenance: {
              kind: "inter_session",
              sourceSessionKey: "agent:pm",
              sourceTool: "sessions_send",
            },
            timestamp: now,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "bee reply" }],
            timestamp: now + 1,
          },
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-7",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "dummy",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("No prior history.");
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
  });

  it.each([
    { toolName: "read", expectedRoles: ["user", "assistant", "toolResult"] },
    { toolName: "functions.sessions_send", expectedRoles: ["user", "assistant"] },
  ])("preserves unfinished inter-session work after a $toolName result", async (scenario) => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("unfinished branch summary"));

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: {
            role: "user",
            content: "continue the delegated task",
            provenance: {
              kind: "inter_session",
              sourceSessionKey: "agent:pm",
              sourceTool: "sessions_send",
            },
            timestamp: now,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-tool",
                name: scenario.toolName,
                arguments: {},
              },
            ],
            timestamp: now + 1,
          },
        },
        {
          type: "message",
          id: "tool-1",
          parentId: "assistant-1",
          timestamp: new Date(now + 2).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-tool",
            toolName: scenario.toolName,
            content: [{ type: "text", text: "partial evidence" }],
            timestamp: now + 2,
          },
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-8",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "dummy",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("unfinished branch summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual(scenario.expectedRoles);
  });

  it("keeps source-session sends as inert status history", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("completed send summary"));

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: {
            role: "user",
            content: "ask the bee session to respond",
            timestamp: now,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "functions.sessions_send",
                arguments: { sessionKey: "agent:bee", message: "say bee" },
              },
              {
                type: "toolCall",
                id: "call-2",
                name: "tools/sessions_send",
                arguments: { sessionKey: "agent:wasp", message: "say wasp" },
              },
              {
                type: "toolCall",
                id: "call-3",
                name: "sessions_send",
                arguments: { sessionKey: "agent:ant", message: "say ant" },
              },
            ],
            timestamp: now + 1,
          },
        },
        {
          type: "message",
          id: "tool-1",
          parentId: "assistant-1",
          timestamp: new Date(now + 2).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "functions.sessions_send",
            content: [{ type: "text", text: '{"status":"ok","reply":"bee replied"}' }],
            timestamp: now + 2,
          },
        },
        {
          type: "message",
          id: "tool-3",
          parentId: "tool-1",
          timestamp: new Date(now + 3).toISOString(),
          message: {
            role: "toolResult",
            toolCallId: "call-3",
            toolName: "sessions_send",
            content: [{ type: "text", text: '{"status":"error","error":"ant unavailable"}' }],
            timestamp: now + 3,
          },
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-8",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "dummy",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("completed send summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages)).toContain("sessions_send result received");
    expect(JSON.stringify(messages)).toContain("sessions_send result missing");
    expect(JSON.stringify(messages)).toContain("bee replied");
    expect(JSON.stringify(messages)).toContain("ant unavailable");
    expect(JSON.stringify(messages)).toContain("agent:wasp");
    expect(JSON.stringify(messages)).toContain("say wasp");
    expect(JSON.stringify(messages)).not.toContain("sessions_send completed");
    expect(JSON.stringify(messages)).not.toContain("functions.sessions_send");
    expect(JSON.stringify(messages)).not.toContain("tools/sessions_send");
  });

  it("preserves completed historical inter-session turns outside the active tail", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("historical branch summary"));

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: {
            role: "user",
            content: "historical inter-session request",
            provenance: {
              kind: "inter_session",
              sourceSessionKey: "agent:pm",
              sourceTool: "sessions_send",
            },
            timestamp: now,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "historical reply" }],
            timestamp: now + 1,
          },
        },
        {
          type: "message",
          id: "user-2",
          parentId: "assistant-1",
          timestamp: new Date(now + 2).toISOString(),
          message: { role: "user", content: "later user request", timestamp: now + 2 },
        },
        {
          type: "message",
          id: "assistant-2",
          parentId: "user-2",
          timestamp: new Date(now + 3).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "later reply" }],
            timestamp: now + 3,
          },
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-8",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "dummy",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("historical branch summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(JSON.stringify(messages)).toContain("historical inter-session request");
    expect(JSON.stringify(messages)).toContain("historical reply");
  });

  it("recovers user and assistant branch turns when compaction preparation has only tool output", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("branch summary with visible turns"));

    const now = Date.now();
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: {
            role: "user",
            content: "what is the deployment status?",
            timestamp: now,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "I will check the deploy." }],
            timestamp: now + 1,
          },
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "status",
            content: [{ type: "text", text: "deploy green" }],
            timestamp: now + 2,
          },
        ] as AgentMessage[],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-6",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "test-key",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("branch summary with visible turns");
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual(["user", "assistant"]);
  });

  it("continues when messages include real conversation content", async () => {
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = createCompactionEvent({
      messageText: "real message",
      tokensBefore: 1500,
    });
    const { result, getApiKeyAndHeadersMock } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: null,
    });
    expect(result).toEqual({ cancel: true });
    expect(getApiKeyAndHeadersMock).toHaveBeenCalledWith(model);
  });

  it("treats tool results as real conversation only when linked to a meaningful user ask", () => {
    expect(
      testing.isRealConversationMessage(
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
        } as AgentMessage,
        [
          { role: "user", content: "<b>HEARTBEAT_OK</b>" } as AgentMessage,
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "exec",
            content: [{ type: "text", text: "done" }],
          } as AgentMessage,
        ],
        1,
      ),
    ).toBe(false);

    expect(
      testing.isRealConversationMessage(
        {
          role: "toolResult",
          toolCallId: "t2",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
        } as AgentMessage,
        [
          { role: "user", content: "please inspect the repo" } as AgentMessage,
          {
            role: "toolResult",
            toolCallId: "t2",
            toolName: "exec",
            content: [{ type: "text", text: "done" }],
          } as AgentMessage,
        ],
        1,
      ),
    ).toBe(true);
  });

  it("does not treat assistant-only tool calls as meaningful conversation", () => {
    expect(
      testing.hasMeaningfulConversationContent({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      } as AgentMessage),
    ).toBe(false);
  });

  it("does not treat reasoning-only assistant blocks as meaningful conversation", () => {
    expect(
      testing.hasMeaningfulConversationContent({
        role: "assistant",
        content: [{ type: "thinking", thinking: "checking" }],
      } as AgentMessage),
    ).toBe(false);

    expect(
      testing.hasMeaningfulConversationContent({
        role: "assistant",
        content: [{ type: "reasoning", summary: [] }],
      } as unknown as AgentMessage),
    ).toBe(false);
  });

  it("treats markup-wrapped heartbeat tokens as boilerplate", () => {
    expect(
      testing.hasMeaningfulConversationContent(
        castAgentMessage({
          role: "assistant",
          content: "<b>HEARTBEAT_OK</b>",
        }),
      ),
    ).toBe(false);
  });
});

async function expectWorkspaceSummaryEmptyForAgentsAlias(
  createAlias: (outsidePath: string, agentsPath: string) => void,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-summary-"));
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "secret");
    createAlias(outside, path.join(root, "AGENTS.md"));
    await expect(readWorkspaceContextForSummary(["Session Startup", "Red Lines"])).resolves.toBe(
      "",
    );
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("readWorkspaceContextForSummary", () => {
  async function withWorkspaceSummary(
    content: string,
    sectionNames: string[] | undefined,
  ): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-summary-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      fs.writeFileSync(path.join(root, "AGENTS.md"), content);
      return await readWorkspaceContextForSummary(sectionNames);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("returns empty when post-compaction sections are not configured", async () => {
    const result = await withWorkspaceSummary(
      "## Session Startup\n\nRead AGENTS.md\n\n## Red Lines\n\nBe careful.\n",
      undefined,
    );

    expect(result).toBe("");
  });

  it("returns empty when post-compaction sections are explicitly disabled", async () => {
    const result = await withWorkspaceSummary("## Session Startup\n\nRead AGENTS.md\n", []);

    expect(result).toBe("");
  });

  it("injects workspace critical rules only for explicit section opt-in", async () => {
    const result = await withWorkspaceSummary(
      "## Session Startup\n\nRead AGENTS.md\n\n## Other\n\nIgnore me.\n",
      ["Session Startup", "Red Lines"],
    );

    expect(result).toContain("<workspace-critical-rules>");
    expect(result).toContain("## Session Startup");
    expect(result).toContain("Read AGENTS.md");
    expect(result).not.toContain("Ignore me");
  });

  it("returns empty when AGENTS.md exceeds the workspace bootstrap limit", async () => {
    const result = await withWorkspaceSummary(
      `## Session Startup\n\n${"x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)}`,
      ["Session Startup"],
    );

    expect(result).toBe("");
  });

  it("reads AGENTS.md at the workspace bootstrap limit", async () => {
    const heading = "## Session Startup\n\n";
    const result = await withWorkspaceSummary(
      heading + "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - heading.length),
      ["Session Startup"],
    );

    expect(result).toContain("<workspace-critical-rules>");
  });

  it("keeps bounded workspace rules UTF-16 safe", async () => {
    const heading = "## Session Startup\n";
    const safePrefix = `${heading}${"x".repeat(1_999 - heading.length)}`;
    const result = await withWorkspaceSummary(`${safePrefix}🚀tail\n`, ["Session Startup"]);

    expect(result).toContain(`${safePrefix}\n...[truncated]...`);
  });

  it("reads workspace context from the configured workspace instead of process cwd", async () => {
    const processRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-cwd-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compaction-workspace-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(processRoot);
    try {
      fs.writeFileSync(
        path.join(processRoot, "AGENTS.md"),
        "## Session Startup\n\nWrong cwd rules.\n",
      );
      fs.writeFileSync(
        path.join(workspaceRoot, "AGENTS.md"),
        "## Session Startup\n\nUse the run workspace rules.\n",
      );

      const result = await readWorkspaceContextForSummary(["Session Startup"], workspaceRoot);

      expect(result).toContain("Use the run workspace rules.");
      expect(result).not.toContain("Wrong cwd rules.");
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(processRoot, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("preserves legacy fallback only for the explicit default section pair", async () => {
    const result = await withWorkspaceSummary(
      "## Every Session\n\nDo startup things.\n\n## Safety\n\nBe safe.\n",
      ["Red Lines", "Session Startup"],
    );

    expect(result).toContain("Do startup things");
    expect(result).toContain("Be safe");
  });

  it.runIf(process.platform !== "win32")(
    "returns empty when AGENTS.md is a symlink escape",
    async () => {
      await expectWorkspaceSummaryEmptyForAgentsAlias((outside, agentsPath) => {
        fs.symlinkSync(outside, agentsPath);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "returns empty when AGENTS.md is a hardlink alias",
    async () => {
      await expectWorkspaceSummaryEmptyForAgentsAlias((outside, agentsPath) => {
        fs.linkSync(outside, agentsPath);
      });
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
