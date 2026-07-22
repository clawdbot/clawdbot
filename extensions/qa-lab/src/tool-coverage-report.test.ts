// Qa Lab tests cover tool coverage report plugin behavior.
import { describe, expect, it } from "vitest";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  buildQaToolCoverageReport,
  renderQaToolCoverageMarkdownReport,
} from "./tool-coverage-report.js";

const TEST_TOOL_COVERAGE_ID = "agents.tool-call-handling";

function makeScenario(
  id: string,
  tool: string,
  config: Record<string, unknown> = {},
): QaSeedScenarioWithSource {
  return {
    id,
    title: id,
    surface: "runtime-tools",
    coverage: {
      primary: [TEST_TOOL_COVERAGE_ID],
    },
    objective: "exercise tool",
    successCriteria: ["tool is exercised"],
    sourcePath: `qa/scenarios/runtime/tools/${tool}.yaml`,
    execution: {
      kind: "flow",
      config: {
        ...config,
        toolCoverage: { ...readToolCoverageConfig(config), family: tool },
      },
      flow: {
        steps: [
          {
            name: "noop",
            actions: [{ assert: "true" }],
          },
        ],
      },
    },
  };
}

function readToolCoverageConfig(config: Record<string, unknown>): Record<string, unknown> {
  const toolCoverage = config.toolCoverage;
  return typeof toolCoverage === "object" && toolCoverage !== null && !Array.isArray(toolCoverage)
    ? (toolCoverage as Record<string, unknown>)
    : {};
}

describe("qa tool coverage report", () => {
  it("derives tool fixture rows from tool coverage metadata", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [makeScenario("runtime-tool-apply-patch", "apply-patch")],
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.totalTools).toBe(1);
    expect(report.rows[0]?.tool).toBe("apply-patch");
  });

  it("renders catalog-only tool fixture coverage", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-read", "read", {
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            capabilityLayer: "codex-native-workspace",
            required: true,
          },
        }),
      ],
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.evaluated).toBe(false);
    expect(report.rows).toEqual([
      expect.objectContaining({
        tool: "read",
        bucket: "codex-native-workspace",
        expectedLayer: "codex-native-workspace",
        capabilityLayer: "codex-native-workspace",
        required: true,
        fixtureCount: 1,
        openclaw: "not-run",
        codex: "not-run",
        drift: "not-run",
      }),
    ]);
    expect(renderQaToolCoverageMarkdownReport(report)).toContain(
      "| read | codex-native-workspace | codex-native-workspace | codex-native-workspace | yes | 1 | not-run | not-run | not-run |",
    );
  });

  it("escapes freeform metadata in the markdown table", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-read", "read|file", {
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            capabilityLayer: "codex-native-workspace",
            required: true,
            tracking: "#80236",
            reason: "tracked | runtime drift",
            codexDefaultImpact: "P2 | default",
            qaImpact: "P1 | confidence",
            action: "fix | backfill",
          },
        }),
      ],
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    const markdown = renderQaToolCoverageMarkdownReport(report);

    expect(markdown).toContain("read\\|file");
    expect(markdown).toContain("P2 \\| default");
    expect(markdown).toContain("P1 \\| confidence");
    expect(markdown).toContain("fix \\| backfill");
    expect(markdown).toContain("#80236 tracked \\| runtime drift");
  });

  it("uses runtime parity summary rows and allows tracked known-broken drift", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-read", "read"),
        makeScenario("tool-write", "write", {
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
          knownBroken: {
            issue: "#80236",
            reason: "tracked runtime drift",
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool read",
            status: "pass",
            runtimeParity: {
              scenarioId: "tool-read",
              drift: "none",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "read", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
          {
            name: "tool write",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-write",
              drift: "tool-result-shape",
              driftDetails: "tool result differs",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "write", argsHash: "a", resultHash: "r1" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "write", argsHash: "a", resultHash: "r2" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
        run: {
          runtimePair: ["openclaw", "codex"],
        },
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.passingTools).toBe(1);
    expect(report.trackedTools).toBe(1);
    expect(report.rows.find((row) => row.tool === "write")).toEqual(
      expect.objectContaining({
        drift: "tool-result-shape",
        tracking: "#80236 tracked runtime drift",
      }),
    );
  });

  it("keeps optional plugin-dependent tool drift report-only", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-optional", "optional", {
          expectedAvailable: false,
          toolCoverage: {
            bucket: "optional-profile-or-plugin",
            expectedLayer: "profile-or-plugin",
            required: false,
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool optional",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-optional",
              drift: "tool-call-shape",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "optional", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        bucket: "optional-profile-or-plugin",
        expectedLayer: "profile-or-plugin",
        required: false,
        drift: "tool-call-shape",
      }),
    );
  });

  it("keeps searchable OpenClaw dynamic tool rows report-only by default", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-searchable-web-search", "web-search", {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            capabilityLayer: "openclaw-dynamic-searchable",
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool web_search searchable",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-searchable-web-search",
              drift: "tool-call-shape",
              driftDetails: "searchable discovery was report-only",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.reportOnlyTools).toBe(1);
    expect(report.passingTools).toBe(0);
    expect(report.searchableDynamicTools).toBe(1);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        capabilityLayer: "openclaw-dynamic-searchable",
        required: false,
        drift: "tool-call-shape",
      }),
    );
  });

  it("passes required OpenClaw dynamic tool coverage when both runtimes exercise the tool", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-web-search", "web-search", {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            capabilityLayer: "openclaw-dynamic-direct",
            required: true,
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool web_search",
            status: "pass",
            runtimeParity: {
              scenarioId: "tool-web-search",
              drift: "tool-result-shape",
              driftDetails: "runtime envelopes differ",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r1" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r2" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.passingTools).toBe(1);
  });

  it("passes required OpenClaw dynamic tool coverage when Codex reports a soft tool error", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-web-search", "web-search", {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            capabilityLayer: "openclaw-dynamic-direct",
            required: true,
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool web_search",
            status: "pass",
            runtimeParity: {
              scenarioId: "tool-web-search",
              drift: "tool-result-shape",
              driftDetails: "Codex maps the controlled tool fault differently",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r1" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r2" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  runtimeErrorClass: "tool-error",
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.rows[0]).toEqual(
      expect.objectContaining({
        codex: "pass",
        drift: "tool-result-shape",
      }),
    );
  });

  it("fails required OpenClaw dynamic tool coverage when a runtime skips the tool", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-web-search", "web-search", {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            capabilityLayer: "openclaw-dynamic-direct",
            required: true,
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool web_search",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-web-search",
              drift: "tool-call-shape",
              driftDetails: "Codex emitted no web_search call",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toEqual(["web-search missing codex tool call web_search"]);
  });

  it("fails required OpenClaw dynamic tool coverage when the fixture failure mode is preserved", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-web-search", "web-search", {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            capabilityLayer: "openclaw-dynamic-direct",
            required: true,
          },
        }),
      ],
      summary: {
        scenarios: [
          {
            name: "tool web_search",
            status: "fail",
            runtimeParity: {
              scenarioId: "tool-web-search",
              drift: "failure-mode",
              driftDetails: "at least one runtime failed",
              cells: {
                openclaw: {
                  runtime: "openclaw",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
                codex: {
                  runtime: "codex",
                  transcriptBytes: "",
                  toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
                  finalText: "",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  wallClockMs: 1,
                  bootStateLines: [],
                },
              },
            },
          },
        ],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      "web-search drift=failure-mode (at least one runtime failed)",
    ]);
  });

  it("fails untracked required tools missing from an evaluated summary", () => {
    const report = buildQaToolCoverageReport({
      scenarios: [
        makeScenario("tool-web-search", "web-search", {
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
            capabilityLayer: "openclaw-dynamic-direct",
            required: true,
          },
        }),
      ],
      summary: {
        scenarios: [],
      },
      generatedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toEqual(["web-search drift=not-run"]);
  });

  it("rejects unknown runtime tool coverage buckets", () => {
    expect(() =>
      buildQaToolCoverageReport({
        scenarios: [
          makeScenario("tool-bad", "bad", {
            toolCoverage: {
              bucket: "required-default",
            },
          }),
        ],
      }),
    ).toThrow("unknown runtime tool coverage bucket");
  });

  it("rejects unknown runtime capability layers", () => {
    expect(() =>
      buildQaToolCoverageReport({
        scenarios: [
          makeScenario("tool-bad-layer", "bad", {
            toolCoverage: {
              bucket: "openclaw-dynamic-integration",
              capabilityLayer: "everything-everywhere",
            },
          }),
        ],
      }),
    ).toThrow("unknown runtime tool capabilityLayer");
  });

  it("discovers the runtime tool fixture catalog", () => {
    const report = buildQaToolCoverageReport({
      scenarios: readQaScenarioPack().scenarios,
      generatedAt: "2026-05-10T00:00:00.000Z",
    });
    const tools = report.rows.map((row) => row.tool);

    expect(tools).toEqual(
      expect.arrayContaining([
        "apply-patch",
        "bash",
        "exec",
        "fs.read",
        "image_generate",
        "memory.recall",
        "message-tool",
        "sessions_spawn",
        "tavily_search",
        "web_fetch",
      ]),
    );
    const applyPatchRow = report.rows.find((row) => row.tool === "apply-patch");
    expect(applyPatchRow).toEqual(
      expect.objectContaining({
        bucket: "codex-native-workspace",
        expectedLayer: "codex-native-workspace",
        required: true,
      }),
    );
    expect(applyPatchRow).toEqual(
      expect.objectContaining({
        tracking:
          "#80320 Codex app-server intentionally owns apply_patch natively; this fixture still needs valid patch-shaped fault injection before it can prove product behavior.",
      }),
    );
    expect(report.rows.find((row) => row.tool === "message-tool")).toEqual(
      expect.objectContaining({
        bucket: "optional-profile-or-plugin",
        expectedLayer: "profile-or-plugin",
        required: false,
        action: "keep report-only in coding profile",
      }),
    );
    expect(report.rows.find((row) => row.tool === "image_generate")).toEqual(
      expect.objectContaining({
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        required: false,
      }),
    );
    expect(report.rows.find((row) => row.tool === "tavily_search")).toEqual(
      expect.objectContaining({
        tracking:
          "#80173 Tavily tools are listed in the phase matrix but are not exposed by the current default tool surface.",
      }),
    );
    expect(report.rows.find((row) => row.tool === "web_search")).toEqual(
      expect.objectContaining({
        bucket: "openclaw-dynamic-integration",
        capabilityLayer: "openclaw-dynamic-direct",
        required: true,
      }),
    );
    expect(report.rows.find((row) => row.tool === "web_search")?.tracking).toBeUndefined();
  });
});
