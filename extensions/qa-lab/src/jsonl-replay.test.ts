import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMockJsonlReplayCellRunner,
  extractJsonlReplayUserTurns,
  renderJsonlReplayMarkdownReport,
  runJsonlReplay,
  type JsonlReplayCellRunner,
} from "./jsonl-replay.js";
import type { RuntimeId, RuntimeParityCell, RuntimeParityToolCall } from "./runtime-parity.js";

const tempRoots: string[] = [];

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<RuntimeParityCell> = {},
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: `{"message":{"role":"assistant","content":"${runtime} reply"}}\n`,
    toolCalls: [],
    finalText: "same reply",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    wallClockMs: 12,
    bootStateLines: [],
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<RuntimeParityToolCall> = {}): RuntimeParityToolCall {
  return {
    tool: "read",
    argsHash: "args-a",
    resultHash: "result-a",
    ...overrides,
  };
}

async function makeTempDir() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jsonl-replay-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
});

describe("jsonl replay", () => {
  it("extracts user-turn boundaries while ignoring system, tool-only, empty, and malformed rows", () => {
    const turns = extractJsonlReplayUserTurns(
      [
        `{"message":{"role":"system","content":"System setup"}}`,
        `{"message":{"role":"tool","content":"tool-only prelude"}}`,
        `{"message":{"role":"user","content":"   "}}`,
        `{not-json`,
        `{"message":{"role":"assistant","content":"Ready."}}`,
        `{"message":{"role":"user","content":[{"type":"text","text":"Plan the release"},{"type":"tool_result","content":"ignored"}]}}`,
        `{"role":"user","content":[{"type":"input_text","text":"Check the follow-up"}]}`,
      ].join("\n"),
    );

    expect(turns).toEqual([
      expect.objectContaining({
        turn: 1,
        lineNumber: 6,
        userText: "Plan the release",
      }),
      expect.objectContaining({
        turn: 2,
        lineNumber: 7,
        userText: "Check the follow-up",
      }),
    ]);
    expect(turns[0]?.transcriptPrefix).toContain(`"role":"system"`);
    expect(turns[0]?.transcriptPrefix).not.toContain("{not-json");
  });

  it("reports the earliest divergent turn using runtime parity drift classes", async () => {
    const transcriptDir = await makeTempDir();
    await fs.writeFile(
      path.join(transcriptDir, "three-turns.jsonl"),
      [
        `{"message":{"role":"user","content":"Turn one"}}`,
        `{"message":{"role":"assistant","content":"Ready"}}`,
        `{"message":{"role":"user","content":"Turn two"}}`,
        `{"message":{"role":"assistant","content":"Using a tool"}}`,
        `{"message":{"role":"user","content":"Turn three"}}`,
      ].join("\n"),
      "utf8",
    );

    const runCell: JsonlReplayCellRunner = async ({ runtime, turn }) => {
      if (turn.turn === 2) {
        return {
          scenarioStatus: "pass",
          cell: makeCell(runtime, {
            toolCalls: [makeToolCall(runtime === "pi" ? {} : { argsHash: "args-codex" })],
          }),
        };
      }
      if (turn.turn === 3) {
        return {
          scenarioStatus: "pass",
          cell: makeCell(runtime, {
            finalText: runtime === "pi" ? "pi wording" : "codex wording",
          }),
        };
      }
      return {
        scenarioStatus: "pass",
        cell: makeCell(runtime),
      };
    };

    const result = await runJsonlReplay(
      {
        directory: transcriptDir,
        runtimePair: ["pi", "codex"],
        providerMode: "mock-openai",
      },
      { runCell },
    );

    expect(result.transcripts).toHaveLength(1);
    expect(result.transcripts[0]).toEqual(
      expect.objectContaining({
        userTurnCount: 3,
        drift: ["none", "tool-call-shape", "text-only"],
        firstDriftAtTurn: 2,
      }),
    );
    expect(result.transcripts[0]?.cells.pi).toHaveLength(3);
    expect(result.transcripts[0]?.cells.codex).toHaveLength(3);
  });

  it("runs the curated replay fixture set in mock-openai mode", async () => {
    const fixtureDir = path.resolve("qa/scenarios/jsonl-replay");

    const result = await runJsonlReplay(
      {
        directory: fixtureDir,
        runtimePair: ["pi", "codex"],
        providerMode: "mock-openai",
      },
      { runCell: createMockJsonlReplayCellRunner() },
    );

    expect(result.transcripts).toHaveLength(7);
    expect(result.transcripts.map((entry) => entry.userTurnCount)).toEqual([2, 2, 3, 2, 2, 2, 2]);
    expect(result.transcripts.every((entry) => entry.firstDriftAtTurn === undefined)).toBe(true);
    expect(
      renderJsonlReplayMarkdownReport({
        generatedAt: "2026-05-10T00:00:00.000Z",
        providerMode: "mock-openai",
        runtimePair: ["pi", "codex"],
        transcripts: result.transcripts,
      }),
    ).toContain("| plan-mode-boundaries.jsonl | 3 |  | none, none, none |");
  });
});
