import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareCompaction,
  type AgentMessage,
  type SessionTreeEntry,
  type StreamFn,
} from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
/** Tests compaction safeguard summaries, quality audit, providers, and runtime settings. */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { jsonResult } from "../tools/common.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import * as compactionQualityModule from "./compaction-safeguard-quality.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const { compactionLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "compaction-safeguard",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { compactionLogger: logger };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => compactionLogger };
});

vi.mock("./compaction-safeguard-quality.js", async () => {
  const actual = await vi.importActual<typeof compactionQualityModule>(
    "./compaction-safeguard-quality.js",
  );
  return { ...actual, auditSummaryQuality: vi.fn(actual.auditSummaryQuality) };
});

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof compactionModule>("../compaction.js");
  return {
    ...actual,
    summarizeInStages: vi.fn(actual.summarizeInStages),
  };
});

const mockSummarizeInStages = vi.mocked(compactionModule.summarizeInStages);
const actualCompactionModule = await vi.importActual<typeof compactionModule>("../compaction.js");
const actualCompactionQualityModule = await vi.importActual<typeof compactionQualityModule>(
  "./compaction-safeguard-quality.js",
);
const mockAuditSummaryQuality = vi.mocked(compactionQualityModule.auditSummaryQuality);

function summaryResult(text: string) {
  return text;
}

// Local projections of the surviving primitives (the .text/.summary wrapper
// helpers were deleted with their prod-dead exports).
function budgetCompactionSummaryText(
  body: string,
  suffix: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): string {
  return (budgetCompactionSummary(body, suffix, maxChars) as { summary: string }).summary;
}

function preservedTurnsText(messages: AgentMessage[]): string {
  return (buildPreservedTurnsSection(messages) as { text: string }).text;
}

const {
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  prependPreviousSummaryForRedistill,
  appendSummarySection,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality: auditSummaryQualityOwner,
  capCompactionSummary,
  budgetCompactionSummary,
  formatFileOperations,
  computeAdaptiveChunkRatio,
  readWorkspaceContextForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  MAX_COMPACTION_SUMMARY_CHARS,
  MAX_FILE_OPS_SECTION_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
  MAX_SPLIT_TURN_CONTEXT_CHARS,
} = testing;

function auditSummaryQuality(
  params: Omit<
    Parameters<typeof compactionQualityModule.auditSummaryQuality>[0],
    "structuralSummary"
  >,
) {
  return auditSummaryQualityOwner({ ...params, structuralSummary: params.summary });
}

beforeEach(() => {
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  mockAuditSummaryQuality.mockImplementation(actualCompactionQualityModule.auditSummaryQuality);
  mockAuditSummaryQuality.mockClear();
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
});

function installCompactionProviderForTest(provider: CompactionProvider): void {
  requireActivePluginRegistry().compactionProviders.push({ provider });
}

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
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

const requireRecord = createRequireRecord("object", "expected-record");

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

    const capped = budgetCompactionSummaryText(body, suffix);

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

    const capped = budgetCompactionSummaryText(body, diagnosticSuffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("## Tool Failures");
    expect(capped).toContain("<read-files>");
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped.endsWith(diagnosticSuffix)).toBe(true);
  });

  it("keeps section separator when body ends without newline (e.g. buildStructuredFallbackSummary)", () => {
    const bodyNoNewline = "## Exact identifiers\nNone.";
    const suffixNoLeadingNewline = "## Tool Failures\n- exec: failed";

    const capped = budgetCompactionSummaryText(bodyNoNewline, `\n\n${suffixNoLeadingNewline}`);

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

  it("uses truncation markers when the budget exactly fits only the marker", () => {
    expect(capCompactionSummary("oversized".repeat(10), SUMMARY_TRUNCATED_MARKER.length)).toBe(
      SUMMARY_TRUNCATED_MARKER,
    );
    expect(
      budgetCompactionSummaryText(
        "",
        "oversized suffix".repeat(10),
        CONTEXT_TRUNCATED_MARKER.length,
      ),
    ).toBe(CONTEXT_TRUNCATED_MARKER);
  });

  it("preserves tail sections when suffix exceeds cap (workspace rules, diagnostics over preserved turns)", () => {
    const criticalTail =
      "\n\n## Tool Failures\n- exec: failed\n\n<read-files>\nfoo.ts\n</read-files>\n\n" +
      "<workspace-critical-rules>\n## Session Startup\nRead AGENTS.md\n</workspace-critical-rules>";
    const preservedTurns =
      "## Recent turns preserved verbatim\n- User: x\n- Assistant: y\n" +
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS);
    const oversizedSuffix = preservedTurns + criticalTail;

    const capped = budgetCompactionSummaryText("short body", oversizedSuffix);

    expect(capped.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(capped).toContain("<workspace-critical-rules>");
    expect(capped).toContain("## Tool Failures");
    expect(capped).toContain("<read-files>");
    expect(capped).toContain("## Session Startup");
  });

  it("moves split-turn quality facts into a short body before suffix pressure", () => {
    const latestAsk = "delete production only after verified backup";
    const carriedIdentifier = "/tmp/carried-forward.log";
    const identifier = "/tmp/split-turn-short-body.log";
    const body = [
      "## Decisions",
      "Keep current flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      "Continue the active work.",
      "## Exact identifiers",
      carriedIdentifier,
    ].join("\n");
    const suffix = `\n\n**Turn Context (split turn):**\n${latestAsk}\n${identifier}\n${"z".repeat(
      MAX_COMPACTION_SUMMARY_CHARS,
    )}`;
    const auditSummary = `${body}${suffix}`;
    const finalized = requireRecord(
      budgetCompactionSummary(body, suffix, MAX_COMPACTION_SUMMARY_CHARS, {
        auditSummary,
        identifiers: [identifier],
        latestAsk,
        latestAskCompleted: false,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );
    if (typeof finalized.summary !== "string" || typeof finalized.structuralSummary !== "string") {
      throw new Error("expected finalized summary strings");
    }
    const summary = finalized.summary;
    const structuralSummary = finalized.structuralSummary;

    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(structuralSummary).toContain(latestAsk);
    expect(structuralSummary).toContain(identifier);
    expect(structuralSummary).toContain(carriedIdentifier);
    expect(auditSummaryQuality({ summary, identifiers: [identifier], latestAsk }).ok).toBe(true);
  });

  it("moves a normal latest ask out of prose that final budgeting trims", () => {
    const latestAsk = "delete production only after verified backup";
    const identifier = "/tmp/normal-turn-retention.log";
    const body = [
      "## Decisions",
      latestAsk,
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      "Continue the active work.",
      "## Exact identifiers",
      identifier,
    ].join("\n");
    const finalized = requireRecord(
      budgetCompactionSummary(body, "", MAX_COMPACTION_SUMMARY_CHARS, {
        auditSummary: body,
        identifiers: [identifier],
        latestAsk,
        latestAskCompleted: false,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );
    if (typeof finalized.summary !== "string" || typeof finalized.structuralSummary !== "string") {
      throw new Error("expected finalized summary strings");
    }

    expect(finalized.summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(finalized.structuralSummary).toContain(
      `## Pending user asks\nContinue the active work.\n${latestAsk}`,
    );
    expect(
      auditSummaryQuality({ summary: finalized.summary, identifiers: [identifier], latestAsk }).ok,
    ).toBe(true);
  });

  it("retains a completed latest ask outside the pending section", () => {
    const latestAsk = "combine the bars into one box per provider";
    const body = [
      "## Decisions",
      `${latestAsk} is completed.`,
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Validate in the browser.",
      "## Pending user asks",
      "None.",
      "## Exact identifiers",
      "None captured.",
    ].join("\n");
    const finalized = requireRecord(
      budgetCompactionSummary(body, "", MAX_COMPACTION_SUMMARY_CHARS, {
        auditSummary: body,
        identifiers: [],
        latestAsk,
        latestAskCompleted: true,
        requiredAskContext: latestAsk,
        identifierPolicy: "strict",
      }),
    );
    if (typeof finalized.summary !== "string" || typeof finalized.structuralSummary !== "string") {
      throw new Error("expected finalized summary strings");
    }

    expect(finalized.structuralSummary).toContain(`Latest turn completed:\n${latestAsk}`);
    expect(finalized.structuralSummary).toContain("## Pending user asks\nNone.");
    expect(
      auditSummaryQuality({
        summary: finalized.summary,
        identifiers: [],
        latestAsk,
        latestAskCompleted: true,
      }),
    ).toEqual({ ok: true, reasons: [] });
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

  it("consumes cancellation provenance once without dropping other runtime fields", () => {
    const sm = {};
    const error = Object.assign(new Error("provider unavailable"), { status: 503 });
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.6 });
    setCompactionSafeguardCancellation(sm, "summarization failed", error);

    expect(consumeCompactionSafeguardCancellation(sm)).toEqual({
      reason: "summarization failed",
      error: expect.objectContaining({ message: "provider unavailable", status: 503 }),
    });
    expect(consumeCompactionSafeguardCancellation(sm)).toBeNull();
    expect(getCompactionSafeguardRuntime(sm)).toEqual({ maxHistoryShare: 0.6 });
  });

  it("replaces provider failure provenance with an intentional decline atomically", () => {
    const sm = {};
    setCompactionSafeguardCancellation(sm, "summary failed", new Error("request timed out"));
    setCompactionSafeguardCancellation(sm, "quality guard declined");

    expect(consumeCompactionSafeguardCancellation(sm)).toEqual({
      reason: "quality guard declined",
    });
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("clears the pending cancellation and its error before another attempt", () => {
    const sm = {};
    setCompactionSafeguardCancellation(sm, "summary failed", new Error("request timed out"));
    setCompactionSafeguardCancellation(sm, undefined);

    expect(consumeCompactionSafeguardCancellation(sm)).toBeNull();
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
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
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "older answer" }],
        timestamp: 2,
      }),
      { role: "user", content: "recent ask", timestamp: 3 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "recent answer" }],
        timestamp: 4,
      }),
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages).toHaveLength(2);
    expect(split.summarizableMessages).toHaveLength(2);
    expect(preservedTurnsText(split.preservedMessages)).toContain(
      "## Recent turns preserved verbatim",
    );
  });

  it("drops orphaned tool results from preserved assistant turns", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "older ask", timestamp: 1 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "read", arguments: {} }],
        timestamp: 2,
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_old",
        toolName: "read",
        content: [{ type: "text", text: "old result" }],
        timestamp: 3,
      }),
      { role: "user", content: "recent ask", timestamp: 4 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
        timestamp: 5,
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_recent",
        toolName: "read",
        content: [{ type: "text", text: "recent result" }],
        timestamp: 6,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "recent final answer" }],
        timestamp: 7,
      }),
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
        castAgentMessage({
          role: "assistant",
          content: [{ type: "text", text: "older answer" }],
          timestamp: 2,
        }),
        { role: "user", content: "recent ask", timestamp: 3 },
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
          timestamp: 4,
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call_recent",
          toolName: "read",
          content: [{ type: "text", text: "recent raw output" }],
          timestamp: 5,
        }),
        castAgentMessage({
          role: "assistant",
          content: [{ type: "text", text: "recent final answer" }],
          timestamp: 6,
        }),
      ],
      recentTurnsPreserve: 1,
    });

    const section = preservedTurnsText(split.preservedMessages);
    expect(section).toContain("- Tool result (read): recent raw output");
    expect(section).toContain("- User: recent ask");
  });

  it("drops an oversized preserved tool interaction as one atomic group", () => {
    const toolCalls = Array.from({ length: 30 }, (_, index) => ({
      type: "toolCall",
      id: `call_${index}`,
      name: "read",
      arguments: {},
    }));
    const split = splitPreservedRecentTurns({
      messages: [
        { role: "user", content: "recent ask", timestamp: 1 },
        castAgentMessage({ role: "assistant", content: toolCalls, timestamp: 2 }),
        ...toolCalls.map((toolCall, index) =>
          castAgentMessage({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: "read",
            content: [
              {
                type: "text",
                text: `paired-result-${String(index).padStart(2, "0")}-${"x".repeat(700)}`,
              },
            ],
            timestamp: index + 3,
          }),
        ),
        castAgentMessage({
          role: "assistant",
          content: [{ type: "text", text: "terminal answer survives" }],
          timestamp: 33,
        }),
      ],
      recentTurnsPreserve: 1,
    });

    const section = preservedTurnsText(split.preservedMessages) as string;

    expect(section.length).toBeLessThanOrEqual(MAX_SPLIT_TURN_CONTEXT_CHARS);
    expect(section).toContain("[Earlier preserved messages truncated]");
    expect(section).not.toContain("paired-result-00-");
    expect(section).not.toContain("paired-result-29-");
    expect(section).not.toContain("- Tool result (read):");
    expect(section).toContain("- Assistant: terminal answer survives");
    expect(section.split("\n").some((line) => line.startsWith("x"))).toBe(false);
  });

  it("formats preserved non-text messages with placeholders", () => {
    const section = preservedTurnsText([
      castAgentMessage({
        role: "user",
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        timestamp: 1,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_recent", name: "read", arguments: {} }],
        timestamp: 2,
      }),
    ]);

    expect(section).toContain("- User: [non-text content: image]");
    expect(section).toContain("- Assistant: [non-text content: toolCall]");
  });

  it("keeps non-text placeholders for mixed-content preserved messages", () => {
    const section = preservedTurnsText([
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "caption text" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      }),
    ]);

    expect(section).toContain("- User: caption text");
    expect(section).toContain("[non-text content: image]");
  });

  it("keeps bounded preserved-turn text UTF-16 safe", () => {
    const section = preservedTurnsText([
      {
        role: "user",
        content: `${"x".repeat(599)}🚀tail`,
        timestamp: 1,
      },
    ]);

    expect(section).toContain(`- User: ${"x".repeat(599)}...`);
  });

  it("does not add non-text placeholders for text-only content blocks", () => {
    const section = preservedTurnsText([
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "plain text reply" }],
        timestamp: 1,
      }),
    ]);

    expect(section).toContain("- Assistant: plain text reply");
    expect(section).not.toContain("[non-text content]");
  });

  it("caps preserved tail when user turns are below preserve target", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "single user prompt", timestamp: 1 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-1" }],
        timestamp: 2,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-2" }],
        timestamp: 3,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-3" }],
        timestamp: 4,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-4" }],
        timestamp: 5,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-5" }],
        timestamp: 6,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-6" }],
        timestamp: 7,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-7" }],
        timestamp: 8,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant-8" }],
        timestamp: 9,
      }),
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
    expect(preservedTurnsText(split.preservedMessages)).toContain("assistant-8");
    expect(preservedTurnsText(split.preservedMessages)).not.toContain("assistant-2");
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

  it("rejects a completed latest ask when the summary marks it pending", () => {
    const latestAsk = "combine the bars into one box per provider";
    const summary = [
      "## Decisions",
      `${latestAsk} is completed.`,
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Validate in the browser.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      "None captured.",
    ].join("\n");

    expect(
      auditSummaryQuality({
        summary,
        identifiers: [],
        latestAsk,
        latestAskCompleted: true,
      }),
    ).toEqual({ ok: false, reasons: ["completed_latest_user_ask_marked_pending"] });
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

  it("keeps valid host/port identifiers after a long non-identifier token", () => {
    const identifiers = extractOpaqueIdentifiers(
      `${"x".repeat(120_000)} host.local:18789 ` +
        "api.example.com/v1:443 127.0.0.1:8080 sub-domain.example.test:65535",
    );

    expect(identifiers).toStrictEqual([
      "host.local:18789",
      "api.example.com/v1:443",
      "127.0.0.1:8080",
      "sub-domain.example.test:65535",
    ]);
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

  it.each([
    {
      name: "decimal and scientific values",
      input:
        "metric=0.123456789 scientific=1.23456789e10 exponent=1e-987654321 order_id=246813579 hash=deadbeef1234 ambiguous=12345678e10",
      expected: ["246813579", "DEADBEEF1234", "12345678E10"], // pragma: allowlist secret
    },
    {
      name: "signed scientific values with long hex-shaped mantissas",
      input: "negative=12345678e-987654321 positive=12345678e+987654321 ambiguous=12345678e10",
      expected: ["12345678E10"],
    },
    {
      name: "dotted values with long unit suffixes",
      input: "latency=0.123456789seconds size=1.23456789e-987654321megabytes metric=12345678.e10",
      expected: [],
    },
    {
      name: "ambiguous integer tokens and decimal-looking opaque identifiers",
      input: "order_id=246813579xy duration=123456789ms revision=1.23456789abcdef",
      expected: ["246813579xy", "123456789ms", "23456789ABCDEF"],
    },
  ])("classifies $name", ({ input, expected }) => {
    expect(extractOpaqueIdentifiers(input)).toStrictEqual(expected);
  });

  it("filters ordinary short numbers and trims wrapped punctuation", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Year 2026 count 42 port 18789 ticket 123456 URL https://example.com/a, path /tmp/x.log, and tiny /a with prose on/off plus typecheck/lint/format.",
    );

    expect(identifiers).not.toContain("2026");
    expect(identifiers).not.toContain("42");
    expect(identifiers).not.toContain("18789");
    expect(identifiers).not.toContain("/a");
    expect(identifiers).not.toContain("/off");
    expect(identifiers).not.toContain("/lint/format");
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
    const summary = buildStructuredFallbackSummary(undefined);
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain("None captured.");
    expect(summary).not.toContain("N/A (identifier policy off).");
  });

  it("cancels without advancing the boundary when dropped history cannot be summarized", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages
      .mockRejectedValueOnce(new Error("dropped prefix unavailable"))
      .mockResolvedValue(summaryResult("later summary must not run"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      maxHistoryShare: 0.1,
      recentTurnsPreserve: 0,
    });

    const compactionHandler = createCompactionHandler();
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock: vi.fn().mockResolvedValue("test-key"),
    });
    const messagesToSummarize: AgentMessage[] = Array.from({ length: 4 }, (_unused, index) => ({
      role: "user",
      content: `msg-${index}-${"x".repeat(120_000)}`,
      timestamp: index + 1,
    }));
    const transcriptBefore = structuredClone(messagesToSummarize);
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 400_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "Keep security caveats.",
      signal: new AbortController().signal,
    };

    const result = await compactionHandler(event, mockContext);

    expect(result).toEqual({ cancel: true });
    expect(result).not.toHaveProperty("compaction");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(messagesToSummarize).toStrictEqual(transcriptBefore);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
      "Compaction safeguard could not summarize the session: " +
        "Failed to summarize dropped messages. | dropped prefix unavailable",
    );
  });

  it("incorporates a successful dropped-history summary into the main summary", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult("dropped history summary"))
      .mockResolvedValueOnce(summaryResult("main history summary"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      maxHistoryShare: 0.1,
      recentTurnsPreserve: 0,
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
    const transcriptBefore = structuredClone(messagesToSummarize);
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
      compaction?: { summary?: string; firstKeptEntryId?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(result.compaction?.summary).toContain("main history summary");
    expect(result.compaction?.firstKeptEntryId).toBe("entry-1");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const droppedCall = requireRecord(mockCallArg(mockSummarizeInStages));
    expect(droppedCall?.customInstructions).toContain(
      "Produce a compact, factual summary with these exact section headings:",
    );
    expect(droppedCall?.customInstructions).toContain("## Decisions");
    expect(droppedCall?.customInstructions).toContain("Keep security caveats.");
    const mainCall = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(JSON.stringify(mainCall?.messages)).toContain("dropped history summary");
    expect(messagesToSummarize).toStrictEqual(transcriptBefore);
  });

  it("propagates caller abort while summarizing dropped history", async () => {
    mockSummarizeInStages.mockReset();
    const controller = new AbortController();
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const lateSummarizationError = new Error("transport failed after cancellation");
    mockSummarizeInStages
      .mockImplementationOnce(async () => {
        controller.abort(abortError);
        throw lateSummarizationError;
      })
      .mockResolvedValue(summaryResult("later summary must not run"));

    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      maxHistoryShare: 0.1,
      recentTurnsPreserve: 0,
    });

    const compactionHandler = createCompactionHandler();
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyMock: vi.fn().mockResolvedValue("test-key"),
    });
    const messagesToSummarize: AgentMessage[] = Array.from({ length: 4 }, (_unused, index) => ({
      role: "user",
      content: `msg-${index}-${"x".repeat(120_000)}`,
      timestamp: index + 1,
    }));
    const transcriptBefore = structuredClone(messagesToSummarize);
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 400_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: controller.signal,
    };

    await expect(compactionHandler(event, mockContext)).rejects.toBe(abortError);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    expect(messagesToSummarize).toStrictEqual(transcriptBefore);
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

  it("preserves provider-prepared Copilot headers in built-in compaction summarization", async () => {
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
      headers: {
        "Copilot-Integration-Id": "copilot-developer-cli",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Openai-Organization": "github-copilot",
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "X-Test": "1",
      },
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
    expect(summaryCall.headers?.["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
    expect(summaryCall.headers?.["Editor-Plugin-Version"]).toBe("copilot-chat/0.35.0");
    expect(summaryCall.headers?.["Openai-Organization"]).toBe("github-copilot");
    expect(summaryCall.headers?.["User-Agent"]).toBe("GitHubCopilotChat/0.35.0");
    expect(summaryCall.headers?.["X-Test"]).toBe("1");
    expect(summaryCall.headers?.["x-initiator"]).toBe("user");
  });

  it("sends safeguard summaries through the prepared model execution context", async () => {
    testing.setSummarizeInStagesForTest(actualCompactionModule.summarizeInStages);
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture({
      api: "test-api" as never,
      baseUrl: "",
      reasoning: true,
    });
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const providerPrompts: string[] = [];
    const streamFn: StreamFn = (_activeModel, context, options) => {
      expect(options?.reasoning).toBe("high");
      providerPrompts.push(JSON.stringify(context));
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "provider summary" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      });
      stream.end();
      return stream;
    };
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyAndHeadersMock: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
    });
    const compactionHandler = createCompactionHandler();
    const event = {
      ...createCompactionEvent({ messageText: "summarize me", tokensBefore: 1_000 }),
      thinkingLevel: "high" as const,
      streamFn,
    };
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const result = (await compactionHandler(event, mockContext)) as {
      cancel?: boolean;
      compaction?: { summary?: string };
    };

    expect(result.cancel).not.toBe(true);
    expect(result.compaction?.summary).toContain("provider summary");
    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).toContain("[User]: summarize me");
  });

  it("surfaces a total provider failure and leaves the safeguard transcript unchanged", async () => {
    testing.setSummarizeInStagesForTest(actualCompactionModule.summarizeInStages);
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture({
      api: "test-api" as never,
      baseUrl: "",
    });
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: "Cannot convert undefined or null to object",
          timestamp: 1,
        },
      });
      stream.end();
      return stream;
    };
    const mockContext = createCompactionContext({
      sessionManager,
      getApiKeyAndHeadersMock: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
    });
    const compactionHandler = createCompactionHandler();
    const event = {
      ...createCompactionEvent({ messageText: "summarize me", tokensBefore: 1_000 }),
      streamFn,
    };
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };
    const transcriptBefore = structuredClone(event.preparation.messagesToSummarize);

    const result = await compactionHandler(event, mockContext);

    expect(result).toEqual({ cancel: true });
    expect(result).not.toHaveProperty("compaction");
    expect(event.preparation.messagesToSummarize).toStrictEqual(transcriptBefore);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toContain(
      "Cannot convert undefined or null to object",
    );
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
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
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

  it("preserves an above-half built-in body byte-for-byte when it fits the final artifact", async () => {
    const body = `BUILTIN-START${"b".repeat(4_480)}BUILTIN-MIDDLE${"b".repeat(4_480)}BUILTIN-END`;
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult(body));
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
    });
    const event = createCompactionEvent({ messageText: "summarize me", tokensBefore: 1_500 });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expect(expectCompactionResult(result).summary).toBe(body);
    expect(compactionLogger.warn).not.toHaveBeenCalled();
  });

  it("marks a trimmed built-in body and emits one redacted tail-loss warning", async () => {
    const sensitiveSentinel = "body-secret-never-log";
    const body = `${sensitiveSentinel}-${"b".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult(body));
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
    });
    const event = createCompactionEvent({ messageText: "summarize me", tokensBefore: 1_500 });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({
      sessionManager,
      event,
      apiKey: "test-key",
    });

    expect(expectCompactionResult(result).summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(compactionLogger.warn).toHaveBeenCalledOnce();
    const warning = compactionLogger.warn.mock.calls[0]?.join(" ") ?? "";
    expect(warning).toBe("Compaction safeguard: finalized artifact truncated; loss=summary-tail");
    expect(warning).not.toContain(sensitiveSentinel);
  });

  it("preserves audit-required tail sections when an earlier section exhausts the budget", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/compaction-final-audit.log";
    const auditValidBeforeFinalization = [
      "## Decisions",
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      identifier,
    ].join("\n");
    expect(
      auditSummaryQuality({
        summary: auditValidBeforeFinalization,
        identifiers: [identifier],
        latestAsk,
      }).ok,
    ).toBe(true);
    mockSummarizeInStages.mockResolvedValue(summaryResult(auditValidBeforeFinalization));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = {
      ...createCompactionEvent({ messageText: `${latestAsk} ${identifier}`, tokensBefore: 1_500 }),
      preparation: {
        ...createCompactionEvent({
          messageText: `${latestAsk} ${identifier}`,
          tokensBefore: 1_500,
        }).preparation,
        settings: { reserveTokens: 4_000 },
        isSplitTurn: false,
      },
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(summary).toContain("## Open TODOs");
    expect(summary).toContain("## Constraints/Rules");
    expect(summary).toContain(`## Pending user asks\n${latestAsk}`);
    expect(summary).toContain(`## Exact identifiers\n${identifier}`);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("restores source identifiers omitted by an oversized generated summary", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    const generatedSummary = [
      "## Decisions",
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      "None.",
    ].join("\n");
    mockSummarizeInStages.mockResolvedValue(summaryResult(generatedSummary));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = { reserveTokens: 4_000 };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(`## Exact identifiers\nNone.\n${identifier}`);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps real sections when a re-distilled identifier list outgrows the budget", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    // A model that hoards every identifier it has ever seen: the list alone is
    // larger than the whole artifact budget while the real sections stay small.
    const hoardedIdentifiers = Array.from(
      { length: 400 },
      (_, index) => `- /home/vac/clawd/tmp/session-artifacts/run-${index}/output.log`,
    ).join("\n");
    const generatedSummary = [
      "## Decisions",
      "Deployment stays paused until the backup is verified.",
      "## Open TODOs",
      "Verify the backup.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      hoardedIdentifiers,
    ].join("\n");
    expect(generatedSummary.length).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
    mockSummarizeInStages.mockResolvedValue(summaryResult(generatedSummary));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(
      "## Decisions\nDeployment stays paused until the backup is verified.",
    );
    expect(summary).toContain("## Open TODOs\nVerify the backup.");
    expect(summary).toContain(`## Pending user asks\n${latestAsk}`);
    expect(summary).toContain(identifier);
    expect(summary).toContain("run-0/output.log");
    expect(summary).not.toContain("run-399/output.log");
    const identifiersSection = summary.slice(summary.indexOf("## Exact identifiers"));
    expect(identifiersSection.length).toBeLessThanOrEqual(
      MAX_COMPACTION_SUMMARY_CHARS * 0.25 + 200,
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps surplus budget out of the protected sections when trimming", () => {
    const identifier = "/tmp/surplus-compaction-id.log";
    const latestAsk = "preserve the pending deployment status";
    // The re-distilled shape seen in production: every optional section is an
    // empty heading, so all surplus would otherwise flow to the identifier list.
    const body = [
      "## Decisions",
      "## Open TODOs",
      "## Constraints/Rules",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      [identifier, ...Array.from({ length: 300 }, (_, i) => `- /tmp/run-${i}/out.log`)].join("\n"),
    ].join("\n");
    const maxChars = 4_000;
    expect(body.length).toBeGreaterThan(maxChars);

    const finalized = budgetCompactionSummary(body, "", maxChars, {
      identifiers: [identifier],
      latestAsk,
      identifierPolicy: "strict",
    });

    const structural = (finalized as { structuralSummary: string }).structuralSummary;
    expect(structural.length).toBeLessThanOrEqual(maxChars);
    expect(structural).toContain("## Decisions");
    expect(structural).toContain(identifier);
    const identifiersSection = structural.slice(structural.indexOf("## Exact identifiers"));
    expect(identifiersSection.length).toBeLessThanOrEqual(maxChars * 0.25 + 100);
  });

  it("caps an identifier list that outgrew its share while the summary still fits", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    const hoardedIdentifiers = Array.from(
      { length: 200 },
      (_, index) => `- /home/vac/clawd/tmp/session-artifacts/run-${index}/output.log`,
    ).join("\n");
    const generatedSummary = [
      "## Decisions",
      "Deployment stays paused until the backup is verified.",
      "## Open TODOs",
      "Verify the backup.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      `${identifier}\n${hoardedIdentifiers}`,
    ].join("\n");
    expect(generatedSummary.length).toBeLessThan(MAX_COMPACTION_SUMMARY_CHARS);
    mockSummarizeInStages.mockResolvedValue(summaryResult(generatedSummary));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(
      "## Decisions\nDeployment stays paused until the backup is verified.",
    );
    expect(summary).toContain(identifier);
    expect(summary).not.toContain("run-199/output.log");
    const identifiersSection = summary.slice(summary.indexOf("## Exact identifiers"));
    expect(identifiersSection.length).toBeLessThanOrEqual(
      MAX_COMPACTION_SUMMARY_CHARS * 0.25 + 200,
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("restores source identifiers omitted by a generated summary that fits the budget", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the pending deployment status";
    const identifier = "/tmp/source-only-compaction-id.log";
    const generatedSummary = [
      "## Decisions",
      "Deployment stays paused.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      "None.",
    ].join("\n");
    mockSummarizeInStages.mockResolvedValue(summaryResult(generatedSummary));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(`## Exact identifiers\nNone.\n${identifier}`);
    expect(summary).not.toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("fails closed when audit-required tail sections cannot fit the artifact cap", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the pending deployment status";
    const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    const oversizedRequiredTail = [
      "## Decisions",
      "Keep current flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      identifier,
    ].join("\n");
    mockSummarizeInStages.mockResolvedValue(summaryResult(oversizedRequiredTail));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 0,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = { reserveTokens: 4_000 };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    expect(result).toEqual({ cancel: true });
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
      "Compaction safeguard required facts exceed the finalized summary budget.",
    );
  });

  it("reserves split-turn ask evidence and identifiers before optional split context", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "preserve the deployment status";
    const identifier = "/tmp/split-turn-retention.log";
    const historySummary = [
      "## Decisions",
      "x".repeat(MAX_COMPACTION_SUMMARY_CHARS),
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve exact context.",
      "## Pending user asks",
      "Continue the active work.",
      "## Exact identifiers",
      "None.",
    ].join("\n");
    const splitSummary = `${latestAsk} ${identifier} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult(historySummary))
      .mockResolvedValueOnce(summaryResult(splitSummary));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "summarize earlier work", timestamp: 1 },
        ] as AgentMessage[],
        turnPrefixMessages: [
          { role: "user", content: `${latestAsk} ${identifier}`, timestamp: 2 },
        ] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(identifier);
    expect(auditSummaryQuality({ summary, identifiers: [identifier], latestAsk }).ok).toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
  });

  it("returns the first finalized retry that passes the source audit", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "report the deployment status";
    const identifier = "/tmp/compaction-retry.log";
    const validRetry = [
      "## Decisions",
      "Keep current flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve context.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      identifier,
    ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult("invalid first attempt"))
      .mockResolvedValueOnce(summaryResult(validRetry));

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = { reserveTokens: 4_000 };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    expect(expectCompactionResult(result).summary).toBe(validRetry);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const retry = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(retry.customInstructions).toContain("Quality check feedback");
    expect(retry.customInstructions).toContain("complete summary body within 16000 UTF-16");
  });

  it("hands the summarizer the full latest turn hidden inside preserved turns", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "combine the bars into one box per provider";
    const completion = "The provider boxes are combined.";
    const structuredSummary = (decision: string, pendingAsk = "None.") =>
      [
        "## Decisions",
        decision,
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Validate in the browser.",
        "## Pending user asks",
        pendingAsk,
        "## Exact identifiers",
        "None captured.",
      ].join("\n");
    // The producer can only classify the ask as completed when it sees both sides of the turn.
    mockSummarizeInStages.mockImplementation(async (params) => {
      const serialized = JSON.stringify(params.messages);
      const decision =
        serialized.includes(latestAsk) && serialized.includes(completion)
          ? `${latestAsk} is completed.`
          : "No current-turn decision captured.";
      return summaryResult(
        structuredSummary(
          decision,
          mockSummarizeInStages.mock.calls.length === 1 ? latestAsk : "None.",
        ),
      );
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 12,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    // Every message is recent enough to be preserved, while bulky results push
    // the ask past the preserved-turns cap. The summary producer still needs
    // the whole latest turn so it can distinguish completed from pending work.
    const toolChain = Array.from({ length: 12 }, (_, index) => {
      const id = `call_${index}`;
      return [
        castAgentMessage({
          role: "assistant",
          content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
          timestamp: 2 + index * 2,
        }),
        castAgentMessage({
          role: "toolResult",
          toolCallId: id,
          toolName: "exec",
          content: [{ type: "text", text: "output ".repeat(200) }],
          timestamp: 3 + index * 2,
        }),
      ];
    }).flat();
    const event = createCompactionEvent({ messageText: latestAsk, tokensBefore: 90_000 });
    event.preparation.messagesToSummarize = [
      { role: "user", content: latestAsk, timestamp: 1 },
      ...toolChain,
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: completion }],
        stopReason: "stop",
        timestamp: 100,
      }),
    ];
    (event.preparation as { settings?: { reserveTokens: number } }).settings = {
      reserveTokens: 4_000,
    };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const finalSummary = expectCompactionResult(result).summary;
    expect(finalSummary).toContain(latestAsk);
    expect(finalSummary).toContain("## Pending user asks\nNone.");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    const call = requireRecord(mockCallArg(mockSummarizeInStages, 0));
    const summarizedMessages = requireArray(call.messages);
    const summarizedRoles = summarizedMessages.map((message) => requireRecord(message).role);
    expect(summarizedRoles).toContain("user");
    expect(JSON.stringify(summarizedMessages)).toContain(completion);
    expect(call.customInstructions).not.toContain(latestAsk);
    const auditInput = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(auditInput.latestAskCompleted).toBe(true);
    const retry = requireRecord(mockCallArg(mockSummarizeInStages, 1));
    expect(retry.customInstructions).toContain("completed_latest_user_ask_marked_pending");
  });

  it("propagates caller abort during corrective generation", async () => {
    mockSummarizeInStages.mockReset();
    const controller = new AbortController();
    const abortError = Object.assign(new Error("corrective compaction aborted"), {
      name: "AbortError",
    });
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult("invalid first attempt"))
      .mockImplementationOnce(async () => {
        controller.abort(abortError);
        throw new Error("transport closed after abort");
      });

    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: "report deployment status",
      tokensBefore: 1_500,
    });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = { reserveTokens: 4_000 };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;
    event.signal = controller.signal;
    const handler = createCompactionHandler();
    const context = createCompactionContext({
      sessionManager,
      getApiKeyMock: vi.fn().mockResolvedValue("test-key"),
    });

    await expect(handler(event, context)).rejects.toBe(abortError);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it.each([true, false])(
    "retries a split-turn summary that revives a completed request (corrected=%s)",
    async (corrected) => {
      mockSummarizeInStages.mockReset();
      const latestAsk = "combine the provider boxes into one completed artifact";
      const identifier = "/tmp/pr130620/live/marker";
      const structuredSummary = (pendingAsk: string) =>
        [
          "## Decisions",
          `${latestAsk} was completed.`,
          "## Open TODOs",
          "None.",
          "## Constraints/Rules",
          "Preserve exact identifiers.",
          "## Pending user asks",
          pendingAsk,
          "## Exact identifiers",
          identifier,
        ].join("\n");
      mockSummarizeInStages
        .mockResolvedValueOnce(summaryResult(structuredSummary(latestAsk)))
        .mockResolvedValueOnce(summaryResult(structuredSummary(corrected ? "None." : latestAsk)));

      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 1,
      });
      const messages: AgentMessage[] = [
        { role: "user", content: `${latestAsk} and preserve ${identifier}`, timestamp: 1 },
        castAgentMessage({
          role: "assistant",
          content: [{ type: "text", text: "The requested artifact is complete." }],
          stopReason: "stop",
          usage: { input: 7_039, output: 34, totalTokens: 7_073 },
          timestamp: 2,
        }),
      ];
      const entries: SessionTreeEntry[] = messages.map((message, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message,
      }));
      const prepared = prepareCompaction(entries, {
        enabled: true,
        reserveTokens: 4_000,
        keepRecentTokens: 0,
      });
      if (!prepared.ok || !prepared.value) {
        throw new Error("expected a prepared split turn");
      }
      expect(prepared.value).toMatchObject({
        firstKeptEntryId: "entry-1",
        turnPrefixMessages: [messages[0]],
        splitTurnCompleted: true,
      });
      const retainedTerminal = structuredClone(entries[1]);
      const event = {
        preparation: prepared.value,
        customInstructions: "",
        signal: new AbortController().signal,
      };

      const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

      expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
      if (corrected) {
        const finalSummary = expectCompactionResult(result).summary;
        expect(finalSummary).not.toContain(`## Pending user asks\n${latestAsk}`);
        expect(finalSummary).toContain("## Pending user asks\nNone.");
      } else {
        expect(result).toEqual({ cancel: true });
        expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toContain(
          "failed quality checks",
        );
      }
      expect(entries[1]).toEqual(retainedTerminal);
      for (const [call] of mockSummarizeInStages.mock.calls) {
        expect(call.messages).toEqual([messages[0]]);
        expect(call.customInstructions).toContain(
          "The split turn is completed; its terminal response is retained outside this prefix.",
        );
      }
      const retry = requireRecord(mockCallArg(mockSummarizeInStages, 1));
      expect(retry.customInstructions).toContain("completed_latest_user_ask_marked_pending");
    },
  );

  it.each([
    { prefixRole: "user", stopReason: "toolUse", completed: false },
    { prefixRole: "user", stopReason: "error", completed: false },
    { prefixRole: "user", stopReason: "aborted", completed: false },
    { prefixRole: "custom", stopReason: "stop", completed: true },
    { prefixRole: "bashExecution", stopReason: "stop", completed: true },
  ] as const)(
    "binds $prefixRole/$stopReason completion in initial and corrective generation",
    async ({ prefixRole, stopReason, completed }) => {
      mockSummarizeInStages.mockReset();
      const historyAsk = "report the deployment status";
      const splitAsk = "inspect the service configuration";
      const latestAsk = prefixRole === "user" ? splitAsk : historyAsk;
      const assistant = (text: string, reason: string) =>
        castAgentMessage({
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: reason,
          timestamp: 2,
          usage: { input: 7_039, output: 34, totalTokens: 7_073 },
        });
      const prefix: AgentMessage =
        prefixRole === "user"
          ? { role: "user", content: splitAsk, timestamp: 3 }
          : prefixRole === "custom"
            ? {
                role: "custom",
                customType: "maintenance",
                content: "maintenance event",
                display: false,
                timestamp: 3,
              }
            : {
                role: "bashExecution",
                command: "true",
                output: "",
                exitCode: 0,
                cancelled: false,
                truncated: false,
                timestamp: 3,
              };
      const messages: AgentMessage[] = [
        { role: "user", content: historyAsk, timestamp: 1 },
        assistant("Deployment is complete.", "stop"),
        prefix,
        assistant("Retained suffix.", stopReason),
      ];
      const entries: SessionTreeEntry[] = messages.map((message, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        timestamp: new Date(index + 1).toISOString(),
        message,
      }));
      const prepared = prepareCompaction(entries, {
        enabled: true,
        reserveTokens: 4_000,
        keepRecentTokens: 0,
      });
      if (!prepared.ok || !prepared.value) {
        throw new Error("expected a prepared split turn");
      }
      expect(prepared.value).toMatchObject({
        firstKeptEntryId: "entry-3",
        isSplitTurn: true,
        splitTurnCompleted: false,
      });
      const validSummary = [
        "## Decisions",
        completed ? `${latestAsk} is completed.` : "Continue the current work.",
        "## Open TODOs",
        "None.",
        "## Constraints/Rules",
        "Preserve context.",
        "## Pending user asks",
        completed ? "None." : latestAsk,
        "## Exact identifiers",
        "None.",
      ].join("\n");
      let historyCalls = 0;
      mockSummarizeInStages.mockImplementation(async ({ messages: summaryMessages }) => {
        if (
          summaryMessages.some(
            (message) => message.role === "user" && message.content === historyAsk,
          )
        ) {
          return ++historyCalls === 1 ? "invalid first attempt" : validSummary;
        }
        return validSummary;
      });
      const sessionManager = stubSessionManager();
      setCompactionSafeguardRuntime(sessionManager, {
        model: createAnthropicModelFixture(),
        recentTurnsPreserve: 0,
        qualityGuardEnabled: true,
        qualityGuardMaxRetries: 1,
      });
      const { result } = await runCompactionScenario({
        sessionManager,
        event: {
          preparation: prepared.value,
          customInstructions: "",
          signal: new AbortController().signal,
        },
        apiKey: "test-key",
      });
      expectCompactionResult(result);
      const prefixCalls = mockSummarizeInStages.mock.calls
        .map(([call]) => call)
        .filter((call) => call.messages[0]?.role === prefixRole && call.messages.length === 1);
      expect(prefixCalls).toHaveLength(2);
      for (const call of prefixCalls) {
        if (prefixRole === "user") {
          expect(call.customInstructions).toContain("The split turn is not completed.");
        } else {
          expect(call.customInstructions).not.toContain("The split turn is ");
        }
        expect(call.messages).toEqual([prefix]);
      }
      expect(mockAuditSummaryQuality).toHaveBeenLastCalledWith(
        expect.objectContaining({ latestAsk, latestAskCompleted: completed }),
      );
    },
  );

  it("audits all-preserved fallback output against pre-partition source facts", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "report deployment status";
    const identifier = "/tmp/all-preserved.log";
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 12,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
      tokensBefore: 1_500,
    });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = { reserveTokens: 4_000 };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
  });

  it("ignores truncated numeric tool-result noise in strict all-preserved audits", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "report metric status";
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 12,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const messagesToSummarize: AgentMessage[] = [
      { role: "user", content: latestAsk, timestamp: 1 },
      castAgentMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_metric", name: "read", arguments: {} }],
        timestamp: 2,
      }),
      castAgentMessage({
        role: "toolResult",
        toolCallId: "call_metric",
        toolName: "read",
        content: [
          {
            type: "text",
            text:
              `${"x".repeat(610)} metric=0.123456789 ` +
              "negative=12345678e-987654321 positive=12345678e+987654321 " +
              "latency=0.123456789seconds size=1.23456789e-987654321megabytes metric=12345678.e10",
          },
        ],
        timestamp: 3,
      }),
      castAgentMessage({
        role: "assistant",
        content: [{ type: "text", text: "metric checked" }],
        timestamp: 4,
      }),
    ];
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        previousSummary: undefined,
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(latestAsk);
    expect(summary).not.toContain("123456789");
    expect(summary).not.toContain("23456789e");
    expect(summary).not.toContain("987654321");
    expect(summary).not.toContain("12345678");
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    expect(mockAuditSummaryQuality).toHaveBeenCalledTimes(1);
    const auditInput = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(auditInput.identifiers).toEqual([]);
  });

  it("summarizes an all-preserved turn when verbatim capping truncates source facts", async () => {
    mockSummarizeInStages.mockReset();
    const latestAsk = "report deployment status";
    const identifier = "/tmp/all-preserved-truncated.log";
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 12,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const sourceText = `${"x".repeat(610)} ${latestAsk} ${identifier}`;
    mockSummarizeInStages.mockImplementation(async (params) => {
      const serialized = JSON.stringify(params.messages);
      return summaryResult(
        [
          "## Decisions",
          serialized.includes(sourceText) ? `${latestAsk} is active.` : "No request captured.",
          "## Open TODOs",
          "None.",
          "## Constraints/Rules",
          "Preserve exact source facts.",
          "## Pending user asks",
          latestAsk,
          "## Exact identifiers",
          serialized.includes(identifier) ? identifier : "None captured.",
        ].join("\n"),
      );
    });
    const event = createCompactionEvent({ messageText: sourceText, tokensBefore: 1_500 });
    (
      event.preparation as { settings?: { reserveTokens: number }; isSplitTurn?: boolean }
    ).settings = { reserveTokens: 4_000 };
    (event.preparation as { isSplitTurn?: boolean }).isSplitTurn = false;

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: "test-key" });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(mockAuditSummaryQuality).toHaveBeenCalledTimes(1);
    const auditInput = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(auditInput.latestAsk).toBe(sourceText);
    expect(auditInput.identifiers).toEqual([identifier]);
    expect(auditInput.summary).toContain("## Recent turns preserved verbatim");
    expect(auditInput.summary).toContain(identifier);
    expect(auditInput.summary).toContain(latestAsk);
    expect(mockAuditSummaryQuality.mock.results[0]?.value).toEqual({ ok: true, reasons: [] });
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("retries when generated summary misses headings even if preserved turns contain them", async () => {
    mockSummarizeInStages.mockReset();
    const preservedUserText = [
      "latest ask status",
      "## Decisions",
      "from preserved turns",
      "## Open TODOs",
      "from preserved turns",
      "## Constraints/Rules",
      "from preserved turns",
      "## Pending user asks",
      "latest ask status",
      "## Exact identifiers",
      "/tmp/preserved-turn-bypass.log",
    ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult("invalid generated body"))
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
            "/tmp/preserved-turn-bypass.log",
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
          castAgentMessage({
            role: "custom",
            customType: "openclaw.runtime-context",
            content: "secret runtime context",
            display: false,
            timestamp: 1.5,
          }),
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
          { role: "user", content: preservedUserText, timestamp: 3 },
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
    const firstAudit = requireRecord(mockCallArg(mockAuditSummaryQuality));
    expect(firstAudit.structuralSummary).toBe("invalid generated body");
    expect(firstAudit.summary).toContain(preservedUserText);
    const secondCall = mockCallArg(mockSummarizeInStages, 1) as {
      customInstructions?: string;
    };
    expect(secondCall.customInstructions).toContain("Quality check feedback");
    expect(secondCall.customInstructions).toContain("missing_section:## Decisions");
    expect(result.compaction?.summary).toContain("## Decisions");
  });

  it("audits preserved latest asks in the exact finalized artifact", async () => {
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
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
          { role: "user", content: "latest ask status", timestamp: 3 },
          castAgentMessage({
            role: "assistant",
            content: "latest assistant reply",
            timestamp: 4,
          }),
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
    expect(result.compaction?.summary).toContain("latest ask status");
  });

  it("cancels when corrective generation fails after finalized quality rejection", async () => {
    mockSummarizeInStages.mockReset();
    const oversizedHistorySummary = "history detail ".repeat(MAX_COMPACTION_SUMMARY_CHARS);
    const splitTurnPrefixSummary = "split-turn prefix context that must survive capping";
    const correctiveFailureMarker = "USER_SESSION_TEXT_issue119932_corrective";
    mockSummarizeInStages
      .mockResolvedValueOnce(summaryResult(oversizedHistorySummary))
      .mockResolvedValueOnce(summaryResult(splitTurnPrefixSummary))
      .mockRejectedValueOnce(new Error(correctiveFailureMarker));

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
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
          { role: "user", content: "latest ask status", timestamp: 3 },
          castAgentMessage({
            role: "assistant",
            content: [{ type: "text", text: "latest assistant reply" }],
            timestamp: 4,
          }),
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

    expect(result).toEqual({ cancel: true });
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(3);
    expect(requireRecord(mockCallArg(mockSummarizeInStages, 1)).customInstructions).toContain(
      "Additional requirements:",
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)?.reason).toBe(
      "Compaction safeguard finalized summary failed quality checks and corrective generation failed.",
    );
    const terminalWarnings = compactionLogger.warn.mock.calls.flat().join("\n");
    expect(terminalWarnings).toContain("reasonCode=corrective_generation_failed");
    expect(terminalWarnings).toContain("attempt=2");
    expect(terminalWarnings).not.toContain(correctiveFailureMarker);
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
          castAgentMessage({
            role: "assistant",
            content: [{ type: "text", text: "latest assistant reply" }],
            timestamp: 2,
          }),
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
    installCompactionProviderForTest({
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
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
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
    installCompactionProviderForTest({
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
    installCompactionProviderForTest({
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
          castAgentMessage({ role: "assistant", content: "older reply", timestamp: 2 }),
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

  it("preserves an above-half provider body byte-for-byte when the joined artifact fits", async () => {
    const providerBody = `BODY-START${"b".repeat(4_480)}BODY-MIDDLE${"b".repeat(4_480)}BODY-END`;
    const providerSummarize = vi.fn().mockResolvedValue(providerBody);
    installCompactionProviderForTest({
      id: "within-budget-provider",
      label: "Within Budget Provider",
      summarize: providerSummarize,
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "within-budget-provider",
      recentTurnsPreserve: 0,
    });
    const event = {
      preparation: {
        messagesToSummarize: [
          { role: "user", content: "summarize the active work", timestamp: 1 },
        ] as AgentMessage[],
        turnPrefixMessages: [
          { role: "user", content: "small split-turn suffix", timestamp: 2 },
        ] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary.startsWith(providerBody)).toBe(true);
    expect(summary).toContain("small split-turn suffix");
    expect(compactionLogger.warn).not.toHaveBeenCalled();
  });

  it("emits one redacted provider warning when the preserved-turn producer truncates", async () => {
    const sensitiveSentinel = "preserved-secret-never-log";
    const providerSummarize = vi.fn().mockResolvedValue("provider summary body");
    installCompactionProviderForTest({
      id: "preserved-overflow-provider",
      label: "Preserved Overflow Provider",
      summarize: providerSummarize,
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "preserved-overflow-provider",
      recentTurnsPreserve: 12,
    });
    const messagesToSummarize = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${sensitiveSentinel}-${"p".repeat(700)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-1",
        tokensBefore: 20_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain("[Earlier preserved messages truncated]");
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(compactionLogger.warn).toHaveBeenCalledOnce();
    const warning = compactionLogger.warn.mock.calls[0]?.join(" ") ?? "";
    expect(warning).toBe(
      "Compaction safeguard: finalized artifact truncated; loss=preserved-turn-head",
    );
    expect(warning).not.toContain(sensitiveSentinel);
  });

  it("retains provider body sentinels and emits one redacted warning when suffixes overflow", async () => {
    const sensitiveSentinel = "credential-sentinel-never-log";
    const providerBody = `BODY-START${"b".repeat(3_400)}BODY-MIDDLE${"b".repeat(3_400)}BODY-END`;
    const providerSummarize = vi.fn().mockResolvedValue(providerBody);
    installCompactionProviderForTest({
      id: "overflow-provider",
      label: "Overflow Provider",
      summarize: providerSummarize,
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "overflow-provider",
      recentTurnsPreserve: 12,
    });
    const messagesToSummarize = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${"p".repeat(700)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const turnPrefixMessages = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `raw-prefix-${index}-${sensitiveSentinel}-${"r".repeat(700)}`,
      timestamp: index + 100,
    }));
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages,
        firstKeptEntryId: "entry-1",
        tokensBefore: 20_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain("BODY-START");
    expect(summary).toContain("BODY-MIDDLE");
    expect(summary).toContain("BODY-END");
    expect(summary).toContain(CONTEXT_TRUNCATED_MARKER.trim());
    expect(compactionLogger.warn).toHaveBeenCalledOnce();
    const warning = compactionLogger.warn.mock.calls[0]?.join(" ") ?? "";
    expect(warning).toBe(
      "Compaction safeguard: finalized artifact truncated; " +
        "loss=split-turn-head,preserved-turn-head,suffix-head",
    );
    expect(warning).not.toContain(sensitiveSentinel);
  });

  it("starts a finally trimmed raw split-turn suffix at a complete message boundary", async () => {
    const providerBody = `BODY-START${"b".repeat(6_760)}BODY-END`;
    const providerSummarize = vi.fn().mockResolvedValue(providerBody);
    installCompactionProviderForTest({
      id: "boundary-provider",
      label: "Boundary Provider",
      summarize: providerSummarize,
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "boundary-provider",
      recentTurnsPreserve: 3,
    });
    const messagesToSummarize = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${"p".repeat(700)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const turnPrefixMessages = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `raw-prefix-${String(index).padStart(2, "0")}-${"r".repeat(700)}`,
      timestamp: index + 100,
    }));
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages,
        firstKeptEntryId: "entry-1",
        tokensBefore: 20_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: null });

    const summary = expectCompactionResult(result).summary;
    const retainedSuffix = summary.split(CONTEXT_TRUNCATED_MARKER)[1] ?? "";
    const firstRetainedLine = retainedSuffix.split("\n").find((line) => line.length > 0);
    expect(firstRetainedLine).toMatch(/^- User: raw-prefix-\d{2}-/);
    expect(summary).toContain("raw-prefix-19-");
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain("## Recent turns preserved verbatim");
  });

  it("finally trims a raw tool interaction only at its atomic boundary", async () => {
    const providerSummarize = vi.fn().mockResolvedValue(`BODY-START${"b".repeat(9_000)}BODY-END`);
    installCompactionProviderForTest({
      id: "tool-boundary-provider",
      label: "Tool Boundary Provider",
      summarize: providerSummarize,
    });
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      provider: "tool-boundary-provider",
      recentTurnsPreserve: 3,
    });
    const messagesToSummarize = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${"p".repeat(600)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const toolCalls = Array.from({ length: 12 }, (_, index) => ({
      type: "toolCall",
      id: `finalizer_call_${index}`,
      name: "read",
      arguments: {},
    }));
    const turnPrefixMessages = [
      { role: "user" as const, content: "raw tool request", timestamp: 100 },
      castAgentMessage({
        role: "assistant" as const,
        content: toolCalls,
        timestamp: 101,
      }),
      ...toolCalls.map((toolCall, index) =>
        castAgentMessage({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: "read",
          content: [
            {
              type: "text",
              text: `finalizer-tool-output-${index}-${"r".repeat(600)}`,
            },
          ],
          timestamp: index + 102,
        }),
      ),
      castAgentMessage({
        role: "assistant" as const,
        content: [{ type: "text", text: "raw terminal answer survives" }],
        timestamp: 114,
      }),
    ];
    const event = {
      preparation: {
        messagesToSummarize,
        turnPrefixMessages,
        firstKeptEntryId: "entry-1",
        tokensBefore: 20_000,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        isSplitTurn: true,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };

    const { result } = await runCompactionScenario({ sessionManager, event, apiKey: null });

    const summary = expectCompactionResult(result).summary;
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain("raw terminal answer survives");
    expect(summary).not.toContain("finalizer-tool-output-");
    expect(summary).not.toContain("- Tool result (read):");
    expect(summary).toContain("## Recent turns preserved verbatim");
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

  it("summarizes only the prepared tool-only window when the context anchors it", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("tool window summary"));

    const now = Date.now();
    // History behind a reset and a compaction boundary: the old fallback re-read
    // all of it through getBranch() and summarized the whole session again.
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        {
          type: "message",
          id: "old-user",
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: { role: "user", content: "old request behind reset", timestamp: now },
        },
        {
          type: "message",
          id: "old-assistant",
          parentId: "old-user",
          timestamp: new Date(now + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "old reply behind reset" }],
            timestamp: now + 1,
          },
        },
        {
          type: "reset",
          id: "reset-1",
          parentId: "old-assistant",
          timestamp: new Date(now + 2).toISOString(),
          reason: "new",
          firstKeptEntryId: "old-assistant",
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "reset-1",
          timestamp: new Date(now + 3).toISOString(),
          summary: "## Decisions\nUser asked for the deploy status.",
          firstKeptEntryId: "compaction-1",
          tokensBefore: 90_000,
          fromHook: true,
        },
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    const toolOnlyWindow = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
        timestamp: now + 4,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "deploy green" }],
        timestamp: now + 5,
      },
    ] as AgentMessage[];
    const mockEvent = {
      preparation: {
        messagesToSummarize: toolOnlyWindow,
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "entry-6",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: false,
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
    expect(compaction.summary).toContain("tool window summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(messages)).not.toContain("behind reset");
  });

  it("recovers real conversation the preparation omitted from its boundary-scoped range", async () => {
    mockSummarizeInStages.mockReset();
    mockSummarizeInStages.mockResolvedValue(summaryResult("range summary"));

    const now = Date.now();
    const entry = (id: string, parentId: string | null, offset: number, message: AgentMessage) => ({
      type: "message",
      id,
      parentId,
      timestamp: new Date(now + offset).toISOString(),
      message: { ...message, timestamp: now + offset },
    });
    const omittedUser = { role: "user", content: "verify the deploy status now" } as AgentMessage;
    const toolCallAssistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
    } as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "deploy green" }],
    } as AgentMessage;
    const sessionManager = {
      ...stubSessionManager(),
      getBranch: () => [
        entry("old-user", null, 0, {
          role: "user",
          content: "old request behind reset",
        } as AgentMessage),
        {
          type: "reset",
          id: "reset-1",
          parentId: "old-user",
          timestamp: new Date(now + 1).toISOString(),
          reason: "new",
          firstKeptEntryId: "reset-1",
        },
        entry("omitted-user", "reset-1", 2, omittedUser),
        entry("assistant-1", "omitted-user", 3, toolCallAssistant),
        entry("tool-1", "assistant-1", 4, toolResult),
        entry("kept-user", "tool-1", 5, { role: "user", content: "and then?" } as AgentMessage),
      ],
    } as ExtensionContext["sessionManager"];
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model, recentTurnsPreserve: 0 });

    // The preparation covers everything before "kept-user" but lost the user turn.
    const mockEvent = {
      preparation: {
        messagesToSummarize: [toolCallAssistant, toolResult],
        turnPrefixMessages: [] as AgentMessage[],
        firstKeptEntryId: "kept-user",
        tokensBefore: 38085,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4000 },
        isSplitTurn: false,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    };
    const { result } = await runCompactionScenario({
      sessionManager,
      event: mockEvent,
      apiKey: "test-key",
    });

    expect(expectCompactionResult(result).summary).toContain("range summary");
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    const summarizeCall = requireRecord(mockCallArg(mockSummarizeInStages));
    const messages = requireArray(summarizeCall.messages);
    expect(messages.map((message) => requireRecord(message).role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("verify the deploy status now");
    expect(serialized).not.toContain("behind reset");
    expect(serialized).not.toContain("and then?");
  });

  it("writes the anti-loop boundary for a tool-only window when nothing anchors it", async () => {
    mockSummarizeInStages.mockReset();
    const sessionManager = stubSessionManager();
    const model = createAnthropicModelFixture();
    setCompactionSafeguardRuntime(sessionManager, { model });

    const mockEvent = {
      preparation: {
        messagesToSummarize: [
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec",
            content: [{ type: "text", text: "heartbeat probe ok" }],
            timestamp: Date.now(),
          },
        ] as AgentMessage[],
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
      apiKey: "test-key",
    });

    const compaction = expectCompactionResult(result);
    expect(compaction.summary).toContain("No prior history.");
    expect(mockSummarizeInStages).not.toHaveBeenCalled();
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
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
      testing.hasMeaningfulConversationContent(
        castAgentMessage({
          role: "assistant",
          content: [{ type: "reasoning", summary: [] }],
        }),
      ),
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
