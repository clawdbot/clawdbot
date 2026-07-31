import { describe, expect, it } from "vitest";
import {
  classifyCodeModeMatrixCell,
  resolveCodeModeMatrixExecutionTransport,
} from "../../../scripts/code-mode-model-matrix.ts";

const successEnvelope = {
  ok: true,
  status: "ok",
  final: "CM-EXPECTED",
  payloads: [{ text: "CM-EXPECTED" }],
  codeModeEngaged: true,
  bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["read"] },
  toolSummary: { calls: 1, tools: ["exec"] },
  model: "qwen3.5:9b",
  provider: "ollama",
  sessionId: "session",
} satisfies Parameters<typeof classifyCodeModeMatrixCell>[0]["envelope"];

describe("Code Mode model matrix transport classification", () => {
  it("classifies bridge, native, mixed, and empty execution transports", () => {
    expect(resolveCodeModeMatrixExecutionTransport(successEnvelope)).toBe("bridge");
    expect(
      resolveCodeModeMatrixExecutionTransport({
        ...successEnvelope,
        toolSummary: { calls: 2, tools: ["read", "exec"], sequence: ["read", "exec"] },
      }),
    ).toBe("bridge");
    expect(
      resolveCodeModeMatrixExecutionTransport({
        ...successEnvelope,
        bridgeCalls: undefined,
        toolSummary: { calls: 1, tools: ["read"], sequence: ["read"] },
      }),
    ).toBe("native");
    expect(
      resolveCodeModeMatrixExecutionTransport({
        ...successEnvelope,
        toolSummary: {
          calls: 3,
          tools: ["exec", "read"],
          sequence: ["read", "read", "exec"],
        },
      }),
    ).toBe("mixed");
    expect(
      resolveCodeModeMatrixExecutionTransport({
        ...successEnvelope,
        bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["edit"] },
        toolSummary: {
          calls: 4,
          tools: ["edit", "read", "exec"],
          sequence: ["edit", "read", "edit", "exec"],
        },
      }),
    ).toBe("mixed");
    expect(
      resolveCodeModeMatrixExecutionTransport({
        ...successEnvelope,
        bridgeCalls: undefined,
        toolSummary: { calls: 0, tools: [] },
      }),
    ).toBe("none");
  });

  it("does not accept bridged targets as native execution evidence", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["read"] },
          toolSummary: { calls: 1, tools: ["read"], sequence: ["read"] },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
  });

  it("accepts native calls around one bridged target with the same tool name", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["edit"] },
          toolSummary: {
            calls: 4,
            tools: ["read", "edit", "exec"],
            sequence: ["read", "edit", "exec", "read"],
          },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "edit-readback",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });

  it("accepts a required sequence split across native and bridged calls", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["write"] },
          toolSummary: {
            calls: 3,
            tools: ["read", "exec"],
            sequence: ["read", "exec", "read"],
          },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "dependent-read-write",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });
});
