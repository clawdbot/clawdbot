import fs from "node:fs/promises";
import path from "node:path";
import {
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityResult,
  type RuntimeParityScenarioExecution,
} from "./runtime-parity.js";

export type JsonlReplayInput = {
  directory: string;
  runtimePair: ["pi", "codex"];
  providerMode: "mock-openai" | "live-frontier";
};

export type JsonlReplayTurn = {
  turn: number;
  lineNumber: number;
  userText: string;
  transcriptPrefix: string;
};

export type JsonlReplayCellRunner = (params: {
  runtime: RuntimeId;
  transcriptPath: string;
  turn: JsonlReplayTurn;
  turns: readonly JsonlReplayTurn[];
  providerMode: JsonlReplayInput["providerMode"];
}) => Promise<RuntimeParityScenarioExecution>;

export type JsonlReplayResult = {
  transcripts: Array<{
    transcriptPath: string;
    userTurnCount: number;
    cells: { pi: RuntimeParityCell[]; codex: RuntimeParityCell[] };
    drift: Array<RuntimeParityResult["drift"]>;
    firstDriftAtTurn?: number;
  }>;
};

export type JsonlReplayOptions = {
  runCell?: JsonlReplayCellRunner;
};

export type JsonlReplayMarkdownReport = {
  generatedAt: string;
  providerMode: JsonlReplayInput["providerMode"];
  runtimePair: JsonlReplayInput["runtimePair"];
  transcripts: JsonlReplayResult["transcripts"];
};

function readReplayMessage(record: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isRecord(record.message)) {
    return record.message;
  }
  return readString(record.role) ? record : undefined;
}

function readRole(message: Record<string, unknown>) {
  return readString(message.role)?.toLowerCase();
}

function isTextLikeContentBlock(block: Record<string, unknown>) {
  const type = readString(block.type)?.toLowerCase();
  return (
    !type ||
    type === "text" ||
    type === "input_text" ||
    type === "message" ||
    type === "output_text" ||
    type === "user_text"
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!isRecord(block) || !isTextLikeContentBlock(block)) {
      continue;
    }
    const text = readString(block.text) ?? readString(block.content);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

export function extractJsonlReplayUserTurns(transcriptBytes: string): JsonlReplayTurn[] {
  const turns: JsonlReplayTurn[] = [];
  const acceptedLines: string[] = [];
  for (const [lineIndex, rawLine] of transcriptBytes.split(/\r?\n/u).entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    acceptedLines.push(trimmed);
    const message = readReplayMessage(parsed);
    if (!message || readRole(message) !== "user") {
      continue;
    }
    const userText = extractTextContent(message.content);
    if (!userText) {
      continue;
    }
    turns.push({
      turn: turns.length + 1,
      lineNumber: lineIndex + 1,
      userText,
      transcriptPrefix: `${acceptedLines.join("\n")}\n`,
    });
  }
  return turns;
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function defaultRunCell(): Promise<RuntimeParityScenarioExecution> {
  throw new Error(
    "jsonl replay requires a runtime cell runner; CLI/suite wiring should provide the Phase 1 runtime parity runner",
  );
}

function assertSupportedRuntimePair(runtimePair: JsonlReplayInput["runtimePair"]) {
  if (runtimePair[0] !== "pi" || runtimePair[1] !== "codex") {
    throw new Error(`unsupported jsonl replay runtime pair: ${runtimePair.join(",")}`);
  }
}

export function createMockJsonlReplayCellRunner(): JsonlReplayCellRunner {
  return async ({ runtime, turn }) => ({
    scenarioStatus: "pass",
    cell: {
      runtime,
      transcriptBytes: turn.transcriptPrefix,
      toolCalls: [],
      finalText: `Replayed curated turn ${turn.turn}.`,
      usage: {
        inputTokens: Math.max(1, Math.ceil(turn.transcriptPrefix.length / 4)),
        outputTokens: 8,
        totalTokens: Math.max(1, Math.ceil(turn.transcriptPrefix.length / 4)) + 8,
      },
      wallClockMs: 1,
      bootStateLines: [],
    },
  });
}

export async function runJsonlReplay(
  input: JsonlReplayInput,
  options: JsonlReplayOptions = {},
): Promise<JsonlReplayResult> {
  assertSupportedRuntimePair(input.runtimePair);
  const directory = path.resolve(input.directory);
  const transcriptPaths = await listJsonlFiles(directory);
  const runCell = options.runCell ?? defaultRunCell;
  const transcripts: JsonlReplayResult["transcripts"] = [];

  for (const transcriptPath of transcriptPaths) {
    const transcriptBytes = await fs.readFile(transcriptPath, "utf8");
    const turns = extractJsonlReplayUserTurns(transcriptBytes);
    const cells: { pi: RuntimeParityCell[]; codex: RuntimeParityCell[] } = {
      pi: [],
      codex: [],
    };
    const drift: Array<RuntimeParityResult["drift"]> = [];
    let firstDriftAtTurn: number | undefined;

    for (const turn of turns) {
      const parity = await runRuntimeParityScenario({
        scenarioId: `${path.basename(transcriptPath)}#turn-${turn.turn}`,
        runCell: async (runtime) =>
          runCell({
            runtime,
            transcriptPath,
            turn,
            turns,
            providerMode: input.providerMode,
          }),
      });
      cells.pi.push(parity.cells.pi);
      cells.codex.push(parity.cells.codex);
      drift.push(parity.drift);
      if (firstDriftAtTurn === undefined && parity.drift !== "none") {
        firstDriftAtTurn = turn.turn;
      }
    }

    transcripts.push({
      transcriptPath,
      userTurnCount: turns.length,
      cells,
      drift,
      ...(firstDriftAtTurn !== undefined ? { firstDriftAtTurn } : {}),
    });
  }

  return { transcripts };
}

export function renderJsonlReplayMarkdownReport(report: JsonlReplayMarkdownReport): string {
  const totalTurns = report.transcripts.reduce((sum, entry) => sum + entry.userTurnCount, 0);
  const driftedTranscripts = report.transcripts.filter(
    (entry) => entry.firstDriftAtTurn !== undefined,
  );
  const lines = [
    `# OpenClaw JSONL Replay Report - ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Provider mode: ${report.providerMode}`,
    `- Transcripts: ${report.transcripts.length}`,
    `- User turns: ${totalTurns}`,
    `- Drifted transcripts: ${driftedTranscripts.length}`,
    "",
    "| Transcript | User turns | First drift turn | Drift sequence |",
    "| --- | ---: | ---: | --- |",
  ];

  for (const transcript of report.transcripts) {
    lines.push(
      `| ${path.basename(transcript.transcriptPath)} | ${transcript.userTurnCount} | ${transcript.firstDriftAtTurn ?? ""} | ${transcript.drift.join(", ")} |`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
