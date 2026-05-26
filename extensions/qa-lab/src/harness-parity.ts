import { createHash } from "node:crypto";
import type {
  RuntimeId,
  RuntimeParityCell,
  RuntimeParityDrift,
  RuntimeParityToolCall,
  RuntimeParityUsage,
} from "./runtime-parity.js";
import type { RuntimeParityComparisonMode } from "./runtime-tool-metadata.js";

export type HarnessVariant = {
  id: string;
  label: string;
  runtime?: RuntimeId;
  model?: string;
  configPatch?: Record<string, unknown>;
  systemPromptOverlay?: string;
  toolDescriptionOverlay?: Record<string, string>;
};

export type HarnessParityDrift =
  | RuntimeParityDrift
  | "system-prompt"
  | "tool-description"
  | "tool-schema";

export type HarnessParityPromptStats = {
  systemPromptChars: number;
  projectContextChars: number;
  nonProjectContextChars: number;
  skillPromptChars: number;
  toolSummaryChars: number;
  toolSchemaChars: number;
  toolCount: number;
};

export type RuntimeParitySystemPromptReport = {
  systemPrompt?: {
    chars?: number;
    projectContextChars?: number;
    nonProjectContextChars?: number;
    text?: string;
    hash?: string;
    contentHash?: string;
  };
  skills?: {
    promptChars?: number;
    prompt?: string;
    hash?: string;
    contentHash?: string;
  };
  tools?: {
    listChars?: number;
    schemaChars?: number;
    entries?: Array<{
      name?: string;
      summary?: string;
      summaryHash?: string;
      summaryChars?: number;
      schema?: unknown;
      schemaHash?: string;
      schemaChars?: number;
      propertiesCount?: number;
    }>;
  };
};

export type HarnessRuntimeParityCell = RuntimeParityCell & {
  systemPromptReport?: RuntimeParitySystemPromptReport;
};

export type HarnessParityCell = HarnessRuntimeParityCell & {
  variant: HarnessVariant;
  promptStats: HarnessParityPromptStats;
  systemPromptHash: string;
  toolDescriptionHash: string;
  toolSchemaHash: string;
  tokenUsage: RuntimeParityUsage;
  tokenUsageSource: "live-usage" | "mock-estimate";
};

export type HarnessParityResult = {
  scenarioId: string;
  left: HarnessParityCell;
  right: HarnessParityCell;
  drift: HarnessParityDrift;
  driftDetails?: string;
  promptDelta: {
    systemPromptChars: number;
    projectContextChars: number;
    skillPromptChars: number;
    toolSummaryChars: number;
    toolSchemaChars: number;
    toolCount: number;
  };
  tokenDeltaPercent: number;
  firstDriftTurn?: number;
};

export type HarnessParityReport = {
  generatedAt: string;
  providerMode: string;
  left: HarnessVariant;
  right: HarnessVariant;
  results: HarnessParityResult[];
  pass: boolean;
  failures: string[];
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function countComparableTranscriptRecords(transcriptBytes: string) {
  let count = 0;
  for (const line of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as {
        message?: { role?: unknown };
        role?: unknown;
      };
      if (
        (parsed.message && typeof parsed.message.role === "string") ||
        typeof parsed.role === "string"
      ) {
        count += 1;
      }
    } catch {
      // Ignore malformed QA transcript rows and keep parity classification deterministic.
    }
  }
  return count;
}

function normalizeForStableHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHash(record[key])]),
    );
  }
  return value;
}

function stableHash(value: unknown) {
  return sha256(JSON.stringify(normalizeForStableHash(value)) ?? "null");
}

function readPositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function buildPromptStats(report: RuntimeParitySystemPromptReport | undefined) {
  const toolEntries = Array.isArray(report?.tools?.entries) ? report.tools.entries : [];
  return {
    systemPromptChars: readPositiveNumber(report?.systemPrompt?.chars),
    projectContextChars: readPositiveNumber(report?.systemPrompt?.projectContextChars),
    nonProjectContextChars: readPositiveNumber(report?.systemPrompt?.nonProjectContextChars),
    skillPromptChars: readPositiveNumber(report?.skills?.promptChars),
    toolSummaryChars: toolEntries.reduce(
      (sum, entry) => sum + readPositiveNumber(entry.summaryChars),
      0,
    ),
    toolSchemaChars: readPositiveNumber(report?.tools?.schemaChars),
    toolCount: toolEntries.length,
  };
}

function estimateUsage(
  cell: RuntimeParityCell,
  stats: HarnessParityPromptStats,
): RuntimeParityUsage {
  const inputChars =
    stats.systemPromptChars +
    stats.skillPromptChars +
    stats.toolSummaryChars +
    stats.toolSchemaChars +
    cell.transcriptBytes.length;
  const outputChars = cell.finalText.length + cell.toolCalls.length * 80;
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function normalizeTextForParity(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

function compareToolCallShape(left: RuntimeParityToolCall[], right: RuntimeParityToolCall[]) {
  if (left.length !== right.length) {
    return `tool call count differs (${left.length} vs ${right.length})`;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      return `tool call row ${index + 1} missing`;
    }
    if (leftCall.tool !== rightCall.tool || leftCall.argsHash !== rightCall.argsHash) {
      return `tool call ${index + 1} differs (${leftCall.tool}/${leftCall.argsHash} vs ${rightCall.tool}/${rightCall.argsHash})`;
    }
  }
  return undefined;
}

function compareToolResultShape(left: RuntimeParityToolCall[], right: RuntimeParityToolCall[]) {
  const total = Math.min(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    const leftCall = left[index];
    const rightCall = right[index];
    if (!leftCall || !rightCall) {
      continue;
    }
    if (
      leftCall.resultHash !== rightCall.resultHash ||
      (leftCall.errorClass ?? "") !== (rightCall.errorClass ?? "")
    ) {
      return `tool result ${index + 1} differs (${leftCall.tool})`;
    }
  }
  return undefined;
}

function firstDriftTurn(leftTranscript: string, rightTranscript: string): number | undefined {
  const leftLines = leftTranscript.trim().length ? leftTranscript.trim().split(/\r?\n/u) : [];
  const rightLines = rightTranscript.trim().length ? rightTranscript.trim().split(/\r?\n/u) : [];
  const total = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < total; index += 1) {
    if ((leftLines[index] ?? "") !== (rightLines[index] ?? "")) {
      return index + 1;
    }
  }
  return undefined;
}

export function buildHarnessParityCell(params: {
  variant: HarnessVariant;
  cell: HarnessRuntimeParityCell;
  tokenUsageSource: HarnessParityCell["tokenUsageSource"];
}): HarnessParityCell {
  const report = params.cell.systemPromptReport;
  const promptStats = buildPromptStats(report);
  const toolEntries = report?.tools?.entries ?? [];
  const tokenUsage =
    params.tokenUsageSource === "live-usage"
      ? params.cell.usage
      : estimateUsage(params.cell, promptStats);
  return {
    ...params.cell,
    variant: params.variant,
    ...(report ? { systemPromptReport: report } : {}),
    promptStats,
    systemPromptHash: stableHash({
      systemPrompt: report?.systemPrompt ?? null,
      skills: report?.skills ?? null,
    }),
    toolDescriptionHash: stableHash(
      toolEntries.map((entry) => {
        return {
          name: entry.name,
          summary: entry.summary,
          summaryHash: entry.summaryHash,
          summaryChars: entry.summaryChars,
        };
      }),
    ),
    toolSchemaHash: stableHash({
      listChars: report?.tools?.listChars,
      schemaChars: report?.tools?.schemaChars,
      entries: toolEntries.map((entry) => {
        return {
          name: entry.name,
          schema: entry.schema,
          schemaHash: entry.schemaHash,
          schemaChars: entry.schemaChars,
          propertiesCount: entry.propertiesCount,
        };
      }),
    }),
    tokenUsage,
    tokenUsageSource: params.tokenUsageSource,
  };
}

export function buildHarnessParityResult(params: {
  scenarioId: string;
  left: HarnessParityCell;
  right: HarnessParityCell;
  comparisonMode?: RuntimeParityComparisonMode;
}): HarnessParityResult {
  const promptDelta = {
    systemPromptChars:
      params.right.promptStats.systemPromptChars - params.left.promptStats.systemPromptChars,
    projectContextChars:
      params.right.promptStats.projectContextChars - params.left.promptStats.projectContextChars,
    skillPromptChars:
      params.right.promptStats.skillPromptChars - params.left.promptStats.skillPromptChars,
    toolSummaryChars:
      params.right.promptStats.toolSummaryChars - params.left.promptStats.toolSummaryChars,
    toolSchemaChars:
      params.right.promptStats.toolSchemaChars - params.left.promptStats.toolSchemaChars,
    toolCount: params.right.promptStats.toolCount - params.left.promptStats.toolCount,
  };
  const tokenDeltaPercent =
    params.left.tokenUsage.totalTokens === 0
      ? params.right.tokenUsage.totalTokens === 0
        ? 0
        : 100
      : ((params.right.tokenUsage.totalTokens - params.left.tokenUsage.totalTokens) /
          params.left.tokenUsage.totalTokens) *
        100;
  const failDetails =
    params.left.transportErrorClass || params.right.transportErrorClass
      ? "at least one harness variant hit a transport failure"
      : params.left.runtimeErrorClass || params.right.runtimeErrorClass
        ? "at least one harness variant hit a runtime failure"
        : undefined;
  if (failDetails) {
    return {
      scenarioId: params.scenarioId,
      left: params.left,
      right: params.right,
      drift: "failure-mode",
      driftDetails: failDetails,
      promptDelta,
      tokenDeltaPercent,
      firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
    };
  }
  if (params.left.systemPromptHash !== params.right.systemPromptHash) {
    return {
      scenarioId: params.scenarioId,
      left: params.left,
      right: params.right,
      drift: "system-prompt",
      driftDetails: "system prompt report differs",
      promptDelta,
      tokenDeltaPercent,
      firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
    };
  }
  if (params.left.toolDescriptionHash !== params.right.toolDescriptionHash) {
    return {
      scenarioId: params.scenarioId,
      left: params.left,
      right: params.right,
      drift: "tool-description",
      driftDetails: "tool description summary shape differs",
      promptDelta,
      tokenDeltaPercent,
      firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
    };
  }
  if (params.left.toolSchemaHash !== params.right.toolSchemaHash) {
    return {
      scenarioId: params.scenarioId,
      left: params.left,
      right: params.right,
      drift: "tool-schema",
      driftDetails: "tool schema shape differs",
      promptDelta,
      tokenDeltaPercent,
      firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
    };
  }
  const compareToolShapes =
    params.comparisonMode !== "codex-native-workspace" && params.comparisonMode !== "outcome-only";
  const compareTranscriptStructure =
    params.comparisonMode !== "codex-native-workspace" && params.comparisonMode !== "outcome-only";

  if (compareToolShapes) {
    const toolCallDrift = compareToolCallShape(params.left.toolCalls, params.right.toolCalls);
    if (toolCallDrift) {
      return {
        scenarioId: params.scenarioId,
        left: params.left,
        right: params.right,
        drift: "tool-call-shape",
        driftDetails: toolCallDrift,
        promptDelta,
        tokenDeltaPercent,
        firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
      };
    }
    const toolResultDrift = compareToolResultShape(params.left.toolCalls, params.right.toolCalls);
    if (toolResultDrift) {
      return {
        scenarioId: params.scenarioId,
        left: params.left,
        right: params.right,
        drift: "tool-result-shape",
        driftDetails: toolResultDrift,
        promptDelta,
        tokenDeltaPercent,
        firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
      };
    }
  }
  const leftTranscriptRecords = countComparableTranscriptRecords(params.left.transcriptBytes);
  const rightTranscriptRecords = countComparableTranscriptRecords(params.right.transcriptBytes);
  if (
    compareTranscriptStructure &&
    (leftTranscriptRecords !== rightTranscriptRecords ||
      (!params.left.finalText && !!params.right.finalText) ||
      (!!params.left.finalText && !params.right.finalText))
  ) {
    return {
      scenarioId: params.scenarioId,
      left: params.left,
      right: params.right,
      drift: "structural",
      driftDetails: `transcript/final-text structure differs (${leftTranscriptRecords} message records vs ${rightTranscriptRecords} message records)`,
      promptDelta,
      tokenDeltaPercent,
      firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
    };
  }
  if (
    normalizeTextForParity(params.left.finalText) !== normalizeTextForParity(params.right.finalText)
  ) {
    return {
      scenarioId: params.scenarioId,
      left: params.left,
      right: params.right,
      drift: "text-only",
      driftDetails: "final text differs after whitespace normalization",
      promptDelta,
      tokenDeltaPercent,
      firstDriftTurn: firstDriftTurn(params.left.transcriptBytes, params.right.transcriptBytes),
    };
  }
  return {
    scenarioId: params.scenarioId,
    left: params.left,
    right: params.right,
    drift: "none",
    promptDelta,
    tokenDeltaPercent,
  };
}

function formatPercent(value: number) {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const prefix = normalized > 0 ? "+" : "";
  return `${prefix}${normalized.toFixed(1)}%`;
}

export function renderHarnessParityMarkdownReport(report: HarnessParityReport): string {
  const lines = [
    `# OpenClaw Harness Parity - ${report.left.label} vs ${report.right.label}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Provider mode: ${report.providerMode}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    "",
    "| Scenario | Drift | First drift turn | Token delta | Prompt chars delta | Tool count delta | Details |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const result of report.results) {
    lines.push(
      `| ${result.scenarioId} | ${result.drift} | ${result.firstDriftTurn ?? ""} | ${formatPercent(
        result.tokenDeltaPercent,
      )} | ${result.promptDelta.systemPromptChars} | ${result.promptDelta.toolCount} | ${
        result.driftDetails ?? ""
      } |`,
    );
  }

  if (report.failures.length > 0) {
    lines.push("", "## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
