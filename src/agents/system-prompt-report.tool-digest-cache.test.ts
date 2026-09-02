import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import {
  createCodeModeExecDescriptionUpdater,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import type { AgentTool } from "./runtime/index.js";

const { createHashCalls } = vi.hoisted(() => ({ createHashCalls: { count: 0 } }));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      createHashCalls.count += 1;
      return actual.createHash(...args);
    },
  };
});

const { buildSystemPromptReport } = await import("./system-prompt-report.js");

function makeTool(name: string, description: string): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [], details: {} }),
  };
}

function finalize(tools: AgentTool[]) {
  return finalizeAgentTools({ tools, hookContext: {}, wrapBeforeToolCallHook: false });
}

function buildReport(tools: AgentTool[]) {
  return buildSystemPromptReport({
    source: "run",
    generatedAt: 0,
    bootstrapMaxChars: 20_000,
    systemPrompt: "Tool digest cache probe",
    injectedWorkspaceFiles: [],
    skillsPrompt: "",
    tools,
  });
}

describe("tool summary digest cache", () => {
  it("reuses unchanged digests across real tool finalization without changing the report", () => {
    const definitions = ["read", "search", "shell"].map((name) =>
      makeTool(`probe_${name}`, `Digest probe: ${name}`),
    );
    const firstTools = finalize(definitions);
    createHashCalls.count = 0;
    const first = buildReport(firstTools);
    expect(createHashCalls.count).toBe(8);

    const secondTools = finalize(definitions);
    for (const [index, tool] of secondTools.entries()) {
      expect(tool).not.toBe(firstTools[index]);
      expect(tool.parameters).toBe(firstTools[index]?.parameters);
    }
    createHashCalls.count = 0;
    const second = buildReport(secondTools);

    expect(createHashCalls.count).toBe(2);
    expect(second).toEqual(first);
  });

  it("reports current Code Mode descriptions on retained finalized wrappers", () => {
    const definition = markCodeModeControlTool(makeTool("exec", "Initial catalog probe"));
    const updater = createCodeModeExecDescriptionUpdater(definition);
    try {
      const tools = finalize([definition]);
      const first = buildReport(tools).tools.entries[0];
      updater.update("Updated catalog probe with another capability");
      const second = buildReport(tools).tools.entries[0];

      expect(second?.summaryChars).toBe(definition.description.length);
      expect(second?.summaryHash).not.toBe(first?.summaryHash);
      expect(second?.schemaHash).toBe(first?.schemaHash);
      expect(second).toEqual(buildReport(finalize([definition])).tools.entries[0]);
    } finally {
      updater.dispose();
    }
  });

  it("keeps schema statistics independent of identical names and summaries", () => {
    const tool = makeTool("schema_probe", "Shared schema probe summary");
    const first = buildReport([tool]).tools.entries[0];
    tool.parameters = Type.Object({ path: Type.String(), limit: Type.Integer() });
    const second = buildReport([tool]).tools.entries[0];

    expect(second?.summaryHash).toBe(first?.summaryHash);
    expect(second?.schemaHash).not.toBe(first?.schemaHash);
    expect(second?.propertiesCount).toBe(2);
  });

  it("does not retain oversized summary keys", () => {
    const definition = makeTool("oversized_probe", `Oversized probe ${"x".repeat(5_000)}`);
    const first = buildReport(finalize([definition]));
    const tools = finalize([definition]);
    createHashCalls.count = 0;
    const second = buildReport(tools);

    expect(createHashCalls.count).toBe(3);
    expect(second).toEqual(first);
  });
});
