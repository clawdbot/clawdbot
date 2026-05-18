import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRuntimeParityCell,
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
  type RuntimeParityToolCall,
} from "./runtime-parity.js";

const tempRoots: string[] = [];

function makeToolCall(overrides: Partial<RuntimeParityToolCall> = {}): RuntimeParityToolCall {
  return {
    tool: "read_file",
    argsHash: "args-a",
    resultHash: "result-a",
    ...overrides,
  };
}

function makeCell(
  runtime: RuntimeId,
  overrides: Partial<RuntimeParityCell> = {},
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"role":"assistant"}\n',
    toolCalls: [],
    finalText: "same reply",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    wallClockMs: 25,
    bootStateLines: [],
    ...overrides,
  };
}

function normalizeForStableHashForTest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableHashForTest(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForStableHashForTest(record[key])]),
    );
  }
  return value;
}

function stableHashForTest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForStableHashForTest(value)) ?? "null")
    .digest("hex");
}

type RuntimeParityGatewaySessionFixture = {
  sessionId: string;
  sessionFile?: string;
  updatedAt: number;
  transcriptBytes: string;
  spawnedBy?: string;
  parentSessionKey?: string;
  spawnDepth?: number;
  subagentRole?: string;
};

async function createRuntimeParityGatewayTempRoot(
  fixture: string | RuntimeParityGatewaySessionFixture[],
) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-parity-"));
  tempRoots.push(tempRoot);
  const sessionsDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const fixtures =
    typeof fixture === "string"
      ? [
          {
            sessionId: "session-1",
            sessionFile: "session-1.jsonl",
            updatedAt: 1,
            transcriptBytes: fixture,
          },
        ]
      : fixture;
  const store = Object.fromEntries(
    fixtures.map(({ transcriptBytes: _transcriptBytes, ...entry }) => [
      entry.sessionId,
      {
        ...entry,
        sessionFile: entry.sessionFile ?? `${entry.sessionId}.jsonl`,
      },
    ]),
  );
  await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(store), "utf8");
  await Promise.all(
    fixtures.map((entry) =>
      fs.writeFile(
        path.join(sessionsDir, entry.sessionFile ?? `${entry.sessionId}.jsonl`),
        entry.transcriptBytes,
        "utf8",
      ),
    ),
  );
  return tempRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
});

describe("runtime parity", () => {
  it("classifies identical cells as none", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "same",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime),
      }),
    });

    expect(result.drift).toBe("none");
  });

  it("runs runtime cells serially so shared QA state cannot cross-contaminate", async () => {
    const events: string[] = [];
    const result = await runRuntimeParityScenario({
      scenarioId: "serial",
      runCell: async (runtime) => {
        events.push(`start:${runtime}`);
        await Promise.resolve();
        events.push(`finish:${runtime}`);
        return {
          scenarioStatus: "pass",
          cell: makeCell(runtime),
        };
      },
    });

    expect(result.drift).toBe("none");
    expect(events).toEqual(["start:pi", "finish:pi", "start:codex", "finish:codex"]);
  });

  it("classifies final-text-only differences as text-only", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "text-only",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          finalText: runtime === "pi" ? "hello from pi" : "hello from codex",
        }),
      }),
    });

    expect(result.drift).toBe("text-only");
  });

  it("classifies tool call shape drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-call-shape",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          toolCalls: [makeToolCall(runtime === "pi" ? {} : { argsHash: "args-b" })],
        }),
      }),
    });

    expect(result.drift).toBe("tool-call-shape");
    expect(isRuntimeParityResultPass(result)).toBe(true);
  });

  it("classifies tool result shape drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-result-shape",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          toolCalls: [makeToolCall(runtime === "pi" ? {} : { resultHash: "result-b" })],
        }),
      }),
    });

    expect(result.drift).toBe("tool-result-shape");
  });

  it("classifies transcript-structure drift", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "structural",
      runCell: async (runtime) => ({
        scenarioStatus: "pass",
        cell: makeCell(runtime, {
          transcriptBytes:
            runtime === "pi" ? '{"role":"assistant"}\n' : '{"role":"assistant"}\n{"role":"tool"}\n',
        }),
      }),
    });

    expect(result.drift).toBe("structural");
  });

  it("classifies runtime failures before other drift types", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "failure-mode",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "pi" ? "fail" : "pass",
        cell: makeCell(runtime, runtime === "pi" ? { runtimeErrorClass: "timeout" } : {}),
      }),
    });

    expect(result.drift).toBe("failure-mode");
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });

  it("surfaces tool-call-shape when one runtime fails because the tool path drifted", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-call-failure",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "pi" ? "pass" : "fail",
        cell: makeCell(runtime, {
          toolCalls: runtime === "pi" ? [makeToolCall()] : [],
          ...(runtime === "codex" ? { runtimeErrorClass: "tool-error" } : {}),
        }),
      }),
    });

    expect(result.drift).toBe("tool-call-shape");
    expect(isRuntimeParityResultPass(result)).toBe(false);
  });

  it("surfaces tool-result-shape when a downstream timeout follows divergent tool output", async () => {
    const result = await runRuntimeParityScenario({
      scenarioId: "tool-result-timeout",
      runCell: async (runtime) => ({
        scenarioStatus: runtime === "pi" ? "pass" : "fail",
        cell: makeCell(runtime, {
          toolCalls: [makeToolCall(runtime === "pi" ? {} : { resultHash: "result-b" })],
          ...(runtime === "codex" ? { runtimeErrorClass: "timeout" } : {}),
        }),
      }),
    });

    expect(result.drift).toBe("tool-result-shape");
  });

  it("prefers provider-side mock request snapshots for tool call rows", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot('{"message":{"role":"assistant"}}\n');
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            plannedToolName: "read",
            plannedToolArgs: { path: "QA_KICKOFF_TASK.md" },
            toolOutput: "",
          },
          {
            toolOutput: JSON.stringify({
              status: "ok",
              text: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
            }),
          },
        ],
      }),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
      mockBaseUrl: "http://127.0.0.1:9999",
    });

    expect(cell.toolCalls).toEqual([
      {
        tool: "read",
        argsHash: stableHashForTest({ path: "QA_KICKOFF_TASK.md" }),
        resultHash: stableHashForTest({
          status: "ok",
          text: "QA mission: Understand this OpenClaw repo from source + docs before acting.",
        }),
      },
    ]);
  });

  it("captures chained provider-side tool plans and error outputs in request order", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot('{"message":{"role":"assistant"}}\n');
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            plannedToolName: "read",
            plannedToolArgs: { path: "audit-fixture/README.md" },
            toolOutput: "",
          },
          {
            toolOutput: JSON.stringify({
              status: "ok",
              text: "Release readiness task",
            }),
            plannedToolName: "write",
            plannedToolArgs: { path: "release-audit.json", content: "{}" },
          },
          {
            toolOutput: JSON.stringify({
              status: "failed",
              error: "permission denied",
            }),
          },
        ],
      }),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "pi",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
      mockBaseUrl: "http://127.0.0.1:9999",
    });

    expect(cell.toolCalls).toEqual([
      {
        tool: "read",
        argsHash: stableHashForTest({ path: "audit-fixture/README.md" }),
        resultHash: stableHashForTest({
          status: "ok",
          text: "Release readiness task",
        }),
      },
      {
        tool: "write",
        argsHash: stableHashForTest({ content: "{}", path: "release-audit.json" }),
        resultHash: stableHashForTest({
          status: "failed",
          error: "permission denied",
        }),
        errorClass: "tool-result-error",
      },
    ]);
  });

  it("ignores newer spawned-session transcripts when selecting the final scenario reply", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot([
      {
        sessionId: "parent",
        updatedAt: 10,
        transcriptBytes: JSON.stringify({
          message: {
            role: "assistant",
            content: "parent scenario final",
          },
        }),
      },
      {
        sessionId: "child",
        updatedAt: 20,
        spawnedBy: "agent:main:qa",
        spawnDepth: 1,
        subagentRole: "leaf",
        transcriptBytes: JSON.stringify({
          message: {
            role: "assistant",
            content: "child worker final",
          },
        }),
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.finalText).toBe("parent scenario final");
    expect(cell.transcriptBytes).not.toContain("child worker final");
  });

  it("ignores newer heartbeat-only operational transcripts when selecting the scenario reply", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot([
      {
        sessionId: "scenario",
        updatedAt: 10,
        transcriptBytes: JSON.stringify({
          message: {
            role: "assistant",
            content: "scenario final",
            usage: {
              input: 10,
              output: 5,
              totalTokens: 15,
            },
          },
        }),
      },
      {
        sessionId: "heartbeat",
        updatedAt: 20,
        transcriptBytes: [
          JSON.stringify({
            message: {
              role: "user",
              content:
                "Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK.",
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: "HEARTBEAT_OK",
              usage: {
                input: 100,
                output: 50,
                totalTokens: 150,
              },
            },
          }),
        ].join("\n"),
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "pi",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.finalText).toBe("scenario final");
    expect(cell.usage.totalTokens).toBe(15);
    expect(cell.transcriptBytes).not.toContain("HEARTBEAT_OK");
  });

  it("ignores production heartbeat poll transcripts when selecting the scenario reply", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot([
      {
        sessionId: "scenario",
        updatedAt: 10,
        transcriptBytes: JSON.stringify({
          message: {
            role: "assistant",
            content: "scenario final",
          },
        }),
      },
      {
        sessionId: "heartbeat",
        updatedAt: 20,
        transcriptBytes: [
          JSON.stringify({
            message: {
              role: "user",
              content: "[OpenClaw heartbeat poll]",
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: "HEARTBEAT_OK",
            },
          }),
        ].join("\n"),
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "pi",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.finalText).toBe("scenario final");
    expect(cell.transcriptBytes).not.toContain("[OpenClaw heartbeat poll]");
  });

  it("ignores heartbeat tool-response transcripts when selecting the scenario reply", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot([
      {
        sessionId: "scenario",
        updatedAt: 10,
        transcriptBytes: JSON.stringify({
          message: {
            role: "assistant",
            content: "scenario final",
          },
        }),
      },
      {
        sessionId: "heartbeat-tool",
        updatedAt: 20,
        transcriptBytes: [
          JSON.stringify({
            message: {
              role: "user",
              content: "[OpenClaw heartbeat poll]",
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "call-heartbeat",
                  name: "heartbeat_respond",
                  arguments: {
                    notify: false,
                    outcome: "no_change",
                    summary: "nothing due",
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            message: {
              role: "tool",
              toolCallId: "call-heartbeat",
              content: JSON.stringify({ status: "ok" }),
            },
          }),
        ].join("\n"),
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.finalText).toBe("scenario final");
    expect(cell.transcriptBytes).not.toContain("heartbeat_respond");
  });

  it("ignores due-task heartbeats that run ordinary tools before responding", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot([
      {
        sessionId: "scenario",
        updatedAt: 10,
        transcriptBytes: JSON.stringify({
          message: {
            role: "assistant",
            content: "scenario final",
          },
        }),
      },
      {
        sessionId: "heartbeat-tool-check",
        updatedAt: 20,
        transcriptBytes: [
          JSON.stringify({
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "Run the following periodic tasks (only those due based on their intervals):",
                    "",
                    "- status: Check deployment status",
                    "",
                    "After completing all due tasks, use heartbeat_respond to report the outcome.",
                  ].join("\n"),
                },
              ],
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-read",
                  name: "read",
                  arguments: { file: "HEARTBEAT.md" },
                },
              ],
            },
          }),
          JSON.stringify({
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_call_id: "call-read",
                  content: "deployment ok",
                },
              ],
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-heartbeat",
                  name: "heartbeat_respond",
                  arguments: {
                    notify: false,
                    outcome: "no_change",
                    summary: "deployment ok",
                  },
                },
              ],
            },
          }),
        ].join("\n"),
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.finalText).toBe("scenario final");
    expect(cell.transcriptBytes).not.toContain("deployment ok");
  });

  it("marks captured cells failed when gateway logs contain QA sentinel signatures", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot(
      JSON.stringify({
        message: {
          role: "assistant",
          content: "scenario final",
        },
      }),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: {
        tempRoot,
        logs: () => "codex_app_server progress stalled for run abc123",
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.runtimeErrorClass).toBe("sentinel:stalled-agent-run");
    expect(cell.sentinelFindings?.map((finding) => finding.kind)).toEqual(["stalled-agent-run"]);
  });

  it("marks direct-reply self-message transcripts as captured cell failures", async () => {
    const tempRoot = await createRuntimeParityGatewayTempRoot(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "message",
                input: { action: "send", conversationId: "qa-operator", text: "hello" },
              },
            ],
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "Sent.",
          },
        }),
      ].join("\n"),
    );

    const cell = await captureRuntimeParityCell({
      runtime: "pi",
      gateway: {
        tempRoot,
      },
      scenarioResult: {
        status: "pass",
      },
      wallClockMs: 42,
    });

    expect(cell.finalText).toBe("Sent.");
    expect(cell.runtimeErrorClass).toBe("sentinel:direct-reply-self-message");
    expect(cell.sentinelFindings?.map((finding) => finding.kind)).toEqual([
      "direct-reply-self-message",
    ]);
  });
});
