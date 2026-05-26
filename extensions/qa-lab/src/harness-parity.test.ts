import { describe, expect, it } from "vitest";
import {
  buildHarnessParityCell,
  buildHarnessParityResult,
  type HarnessRuntimeParityCell,
  type HarnessVariant,
} from "./harness-parity.js";
import type { RuntimeId } from "./runtime-parity.js";
import type { RuntimeParityComparisonMode } from "./runtime-tool-metadata.js";

const LEFT: HarnessVariant = { id: "left", label: "Left", runtime: "pi" };
const RIGHT: HarnessVariant = { id: "right", label: "Right", runtime: "pi" };

const BASE_PROMPT_REPORT = {
  systemPrompt: {
    chars: 100,
    projectContextChars: 40,
    nonProjectContextChars: 60,
    hash: "system-a",
  },
  skills: {
    promptChars: 12,
    hash: "skills-a",
  },
  tools: {
    schemaChars: 20,
    entries: [
      {
        name: "read",
        summaryChars: 8,
        summaryHash: "summary-a",
        schemaChars: 20,
        schemaHash: "schema-a",
        propertiesCount: 1,
      },
    ],
  },
};

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<HarnessRuntimeParityCell> = {},
): HarnessRuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"message":{"role":"assistant","content":"same"}}\n',
    toolCalls: [],
    finalText: "same",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    wallClockMs: 1,
    bootStateLines: [],
    systemPromptReport: BASE_PROMPT_REPORT,
    ...overrides,
  };
}

function classify(
  left: Partial<HarnessRuntimeParityCell>,
  right: Partial<HarnessRuntimeParityCell>,
  comparisonMode?: RuntimeParityComparisonMode,
) {
  return buildHarnessParityResult({
    scenarioId: "scenario",
    left: buildHarnessParityCell({
      variant: LEFT,
      cell: makeCell("pi", left),
      tokenUsageSource: "live-usage",
    }),
    right: buildHarnessParityCell({
      variant: RIGHT,
      cell: makeCell("pi", right),
      tokenUsageSource: "live-usage",
    }),
    ...(comparisonMode ? { comparisonMode } : {}),
  }).drift;
}

describe("harness parity", () => {
  it("classifies prompt and tool surface drift before behavioral drift", () => {
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
          },
        },
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            systemPrompt: {
              chars: 100,
              projectContextChars: 40,
              nonProjectContextChars: 60,
              hash: "system-b",
            },
          },
        },
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            skills: { promptChars: 12, hash: "skills-b" },
          },
        },
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            tools: {
              schemaChars: 20,
              entries: [
                {
                  name: "read",
                  summaryChars: 8,
                  summaryHash: "summary-b",
                  schemaChars: 20,
                  schemaHash: "schema-a",
                  propertiesCount: 1,
                },
              ],
            },
          },
        },
      ),
    ).toBe("tool-description");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            tools: {
              schemaChars: 20,
              entries: [
                {
                  name: "read",
                  summaryChars: 8,
                  summaryHash: "summary-a",
                  schemaChars: 20,
                  schemaHash: "schema-b",
                  propertiesCount: 1,
                },
              ],
            },
          },
        },
      ),
    ).toBe("tool-schema");
  });

  it("classifies behavioral harness drift", () => {
    expect(
      classify(
        { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }] },
        { toolCalls: [{ tool: "read", argsHash: "b", resultHash: "r" }] },
      ),
    ).toBe("tool-call-shape");
    expect(
      classify(
        { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r1" }] },
        { toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r2" }] },
      ),
    ).toBe("tool-result-shape");
    expect(classify({ finalText: "same text" }, { finalText: "different text" })).toBe("text-only");
    expect(
      classify(
        {
          transcriptBytes:
            '{"type":"model_change","modelId":"gpt-5.5"}\n' +
            '{"type":"thinking_level_change","thinkingLevel":"off"}\n' +
            '{"type":"custom","customType":"model-snapshot"}\n' +
            '{"message":{"role":"assistant","content":"same"}}\n',
        },
        { transcriptBytes: '{"message":{"role":"assistant","content":"same"}}\n' },
      ),
    ).toBe("none");
    expect(
      classify(
        { transcriptBytes: '{"message":{"role":"assistant"}}\n' },
        { transcriptBytes: '{"message":{"role":"assistant"}}\n{"message":{"role":"tool"}}\n' },
      ),
    ).toBe("structural");
    expect(
      classify(
        { transcriptBytes: '{"role":"assistant","content":"same"}\n' },
        {
          transcriptBytes:
            '{"role":"assistant","content":"same"}\n{"role":"tool","content":"same"}\n',
        },
      ),
    ).toBe("structural");
    expect(classify({ runtimeErrorClass: "timeout" }, {})).toBe("failure-mode");
  });

  it("honors native workspace comparison mode for outcome-only harness proofs", () => {
    expect(
      classify(
        {
          transcriptBytes:
            '{"message":{"role":"assistant","content":"same"}}\n' +
            '{"message":{"role":"tool","content":"same result"}}\n',
          toolCalls: [{ tool: "bash", argsHash: "sed-160", resultHash: "same-result" }],
        },
        {
          transcriptBytes: '{"message":{"role":"assistant","content":"same"}}\n',
          toolCalls: [{ tool: "bash", argsHash: "sed-200", resultHash: "same-result" }],
        },
        "codex-native-workspace",
      ),
    ).toBe("none");

    expect(
      classify(
        { toolCalls: [{ tool: "bash", argsHash: "a", resultHash: "r1" }] },
        { toolCalls: [{ tool: "bash", argsHash: "b", resultHash: "r2" }] },
        "outcome-only",
      ),
    ).toBe("none");
  });

  it("keeps prompt and tool surface checks strict under native workspace comparison mode", () => {
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            systemPrompt: { chars: 101, projectContextChars: 40, nonProjectContextChars: 61 },
          },
          toolCalls: [{ tool: "bash", argsHash: "changed", resultHash: "changed" }],
        },
        "codex-native-workspace",
      ),
    ).toBe("system-prompt");
    expect(
      classify(
        {},
        {
          systemPromptReport: {
            ...BASE_PROMPT_REPORT,
            tools: {
              schemaChars: 20,
              entries: [{ name: "read", summaryChars: 9, schemaChars: 20, propertiesCount: 1 }],
            },
          },
          toolCalls: [{ tool: "bash", argsHash: "changed", resultHash: "changed" }],
        },
        "outcome-only",
      ),
    ).toBe("tool-description");
  });

  it("labels mock token estimates separately from live usage", () => {
    const sourceCell = makeCell("pi", {
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const cell = buildHarnessParityCell({
      variant: LEFT,
      cell: sourceCell,
      tokenUsageSource: "mock-estimate",
    });
    const inputChars = 100 + 12 + 8 + 20 + sourceCell.transcriptBytes.length;

    expect(cell.tokenUsageSource).toBe("mock-estimate");
    expect(cell.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(cell.tokenUsage.inputTokens).toBe(Math.ceil(inputChars / 4));
    expect(cell.promptStats.toolCount).toBe(1);
  });
});
