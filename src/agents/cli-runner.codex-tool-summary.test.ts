/** Tests Codex exec JSONL tool-summary projection through the CLI process boundary. */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPreparedCliRunContext,
  type PreparedCliRunContextOverrides,
} from "./cli-runner.test-helpers.js";
import { createManagedRun, supervisorSpawnMock } from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";

const CODEX_BACKEND: PreparedCliRunContextOverrides["backend"] = {
  output: "jsonl",
  sessionIdFields: ["thread_id"],
  systemPromptFileConfigArg: undefined,
};

function queueCodexFixture(name: string) {
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 10,
      stdout: readFileSync(`test/fixtures/cli/${name}.jsonl`, "utf8"),
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
  );
}

async function runCodexFixture(name: string) {
  queueCodexFixture(name);
  return await executePreparedCliRun(
    buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.5",
      backend: CODEX_BACKEND,
    }),
  );
}

beforeEach(() => {
  supervisorSpawnMock.mockReset();
});

describe("Codex CLI tool summaries", () => {
  it("emits an explicit empty summary for a successful zero-tool turn", async () => {
    const output = await runCodexFixture("codex-tool-summary-zero");

    expect(output.toolSummary).toEqual({ calls: 0, tools: [], failures: 0 });
  });

  it("counts paired MCP lifecycle events once", async () => {
    const output = await runCodexFixture("codex-tool-summary-paired-mcp");

    expect(output.toolSummary).toEqual({ calls: 1, tools: ["github.search"], failures: 0 });
  });

  it("projects terminal-only MCP and native items in first-observed order", async () => {
    const output = await runCodexFixture("codex-tool-summary-terminal-only");

    expect(output.toolSummary).toEqual({
      calls: 4,
      tools: ["lookup", "bash", "apply_patch", "web_search"],
      failures: 0,
    });
  });

  it("counts a typed failed terminal MCP item", async () => {
    const output = await runCodexFixture("codex-tool-summary-failed-mcp");

    expect(output.toolSummary).toEqual({ calls: 1, tools: ["docs.read"], failures: 1 });
  });

  it("counts a declined command terminal as a failure", async () => {
    const output = await runCodexFixture("codex-tool-summary-declined-command");

    expect(output.toolSummary).toEqual({ calls: 1, tools: ["bash"], failures: 1 });
  });

  it.each([
    {
      fixture: "codex-tool-summary-collab-paired",
      tool: "collab.spawn_agent",
      failures: 0,
    },
    {
      fixture: "codex-tool-summary-collab-terminal-only",
      tool: "collab.wait",
      failures: 0,
    },
    {
      fixture: "codex-tool-summary-collab-failed",
      tool: "collab.send_input",
      failures: 1,
    },
    {
      fixture: "codex-tool-summary-collab-close-agent",
      tool: "collab.close_agent",
      failures: 0,
    },
  ])("projects $fixture lifecycle metadata", async ({ fixture, tool, failures }) => {
    const output = await runCodexFixture(fixture);

    expect(output.toolSummary).toEqual({ calls: 1, tools: [tool], failures });
  });
});
