import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "./embedded-agent-runner/run/attempt-tool-run-context.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  testing as registryTesting,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "./tools/structured-output-tool.js";

const runId = "collector-tool-contract";
const sessionKey = "agent:main:subagent:collector-contract";
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "collector-tools-")));
  resetSubagentRegistryForTests({ persist: false });
  registryTesting.setDepsForTest({ persistSubagentRunsToDiskOrThrow: vi.fn() });
});

afterEach(async () => {
  consumeSwarmStructuredOutput(runId);
  resetSubagentRegistryForTests({ persist: false });
  registryTesting.setDepsForTest();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

it.each([
  { collector: true, toolsAllow: undefined },
  { collector: true, toolsAllow: ["read"] },
  { collector: true, toolsAllow: [] },
  { collector: false, toolsAllow: undefined },
  { collector: false, toolsAllow: ["read"] },
])("constructs the real attempt collector surface %j", async ({ collector, toolsAllow }) => {
  addSubagentRunForTests({
    runId,
    childSessionKey: sessionKey,
    collect: collector,
    outputSchema: schema,
  });
  const context = buildEmbeddedAttemptToolRunContext({
    toolsAllow,
    swarmCollector: collector,
    swarmOutputSchema: schema,
  });
  const constructedTools = createOpenClawCodingTools({
    ...context,
    config: {
      agents: { entries: { main: { default: true } } },
      tools: { swarm: true },
    },
    agentId: "main",
    modelProvider: "openai",
    modelId: "gpt-5.6-luna",
    disableMessageTool: true,
    runId,
    sessionKey,
    workspaceDir,
    cwd: workspaceDir,
  });
  const tools = applyEmbeddedAttemptToolsAllow(constructedTools, context.runtimeToolAllowlist);
  const names = tools.map((tool) => tool.name);
  if (toolsAllow) {
    expect(names.toSorted()).toEqual(
      [...toolsAllow, ...(collector ? ["structured_output"] : [])].toSorted(),
    );
  }
  if (!collector) {
    expect(names).not.toContain("structured_output");
    if (!toolsAllow) {
      expect(names).toEqual(expect.arrayContaining(["web_fetch", "sessions_yield"]));
    }
    return;
  }
  for (const forbidden of ["ask_user", "sessions_send", "sessions_yield", "message"]) {
    expect(names).not.toContain(forbidden);
  }
  if (!toolsAllow) {
    expect(names).toEqual(
      expect.arrayContaining(["read", "write", "edit", "apply_patch", "exec", "process"]),
    );
    const write = expectDefined(
      tools.find((tool) => tool.name === "write"),
      "workspace write",
    );
    await write.execute("collector-write", { path: "result.txt", content: "collector file proof" });
    const read = expectDefined(
      tools.find((tool) => tool.name === "read"),
      "workspace read",
    );
    const result = await read.execute("collector-read", { path: "result.txt" });
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("collector file proof"),
      }),
    );
  }
  const output = expectDefined(
    tools.find((tool) => tool.name === "structured_output"),
    "collector output transport",
  );
  expect(output.catalogMode).toBe("direct-only");
  const result = await output.execute("collector-result", { result: { answer: "ok" } });
  expect(result.details).toEqual({ status: "recorded" });
  expect(getSubagentRunByRunId(runId)?.structuredOutput).toEqual({
    structured: { answer: "ok" },
    invalidAttempts: 0,
  });
});
