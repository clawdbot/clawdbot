import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import {
  mockSuccessfulCliRun,
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";

vi.mock("./cli-runner/session-history.js", () => ({
  loadSessionHistory: vi.fn(async () => []),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

type JsonlEvent = Record<string, unknown>;

function codexContext() {
  return buildPreparedCliRunContext({
    provider: "codex-cli",
    backend: {
      command: "codex",
      args: ["exec", "--json"],
      output: "jsonl",
      input: "arg",
      modelArg: "--model",
      sessionArgs: ["exec", "resume", "{sessionId}", "--json"],
    },
  });
}

async function runCodexFixture(events: JsonlEvent[]) {
  mockSuccessfulCliRun(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return await runPreparedCliAgent(codexContext());
}

describe("codex-cli terminal tool summary", () => {
  beforeEach(() => {
    restoreCliRunnerPrepareTestDeps();
    supervisorSpawnMock.mockReset();
  });

  it("preserves an explicit empty summary on a zero-tool success", async () => {
    const result = await runCodexFixture([
      { type: "thread.started", thread_id: "thread-zero" },
      {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: "done" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ]);

    expect(result.meta.toolSummary).toEqual({ calls: 0, tools: [], failures: 0 });
  });

  it("carries correlated, repeated, terminal-only, builtin, and failed calls to metadata", async () => {
    const result = await runCodexFixture([
      { type: "thread.started", thread_id: "thread-tools" },
      {
        type: "item.started",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "finance-data",
          tool: "lookup",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "finance-data",
          tool: "lookup",
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-2",
          type: "mcp_tool_call",
          server: "finance-data",
          tool: "lookup",
          status: "failed",
          error: { message: "fixture failure" },
        },
      },
      {
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "pwd",
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "patch-1",
          type: "file_change",
          changes: [],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "search-1",
          type: "web_search",
          query: "provider-free fixture",
        },
      },
      {
        type: "item.completed",
        item: { id: "message", type: "agent_message", text: "done" },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ]);

    expect(result.meta.toolSummary).toEqual({
      calls: 5,
      tools: ["finance-data.lookup", "bash", "apply_patch", "web_search"],
      failures: 1,
    });
  });
});
