import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../runtime/index.js";
import {
  createToolDefinitionFromAgentTool,
  wrapToolDefinition,
} from "./tool-definition-wrapper.js";

describe("tool definition result content source", () => {
  it("survives both AgentTool adapter directions", () => {
    const tool: AgentTool = {
      name: "network_reader",
      label: "Network reader",
      description: "Reads external content",
      parameters: Type.Object({}),
      resultContentSource: "network",
      execute: async () => ({ content: [], details: {} }),
    };

    const definition = createToolDefinitionFromAgentTool(tool);
    expect(definition.resultContentSource).toBe("network");
    expect(wrapToolDefinition(definition).resultContentSource).toBe("network");
  });
});
