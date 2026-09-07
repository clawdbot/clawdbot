import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeModeTools, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  mcpTool,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

afterEach(resetCodeModeTestState);

describe("Code Mode tool execution scheduling", () => {
  it.each([
    { surface: "interactive", source: "native" },
    { surface: "headless", source: "native" },
    { surface: "interactive", source: "mcp" },
    { surface: "headless", source: "mcp" },
  ] as const)(
    "honors sequential-only $source tools through $surface execution",
    async ({ surface, source }) => {
      let active = 0;
      let maximumActive = 0;
      let calls = 0;
      const execute: AnyAgentTool["execute"] = async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          // A real host turn lets every incorrectly parallel invocation enter.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          return source === "mcp"
            ? projectMcpCallToolResult({ structuredContent: { ok: true } })
            : jsonResult({ ok: true });
        } finally {
          active -= 1;
        }
      };
      const tool: AnyAgentTool =
        source === "mcp"
          ? mcpTool({
              name: "probe__ordered_probe",
              serverName: "probe",
              toolName: "ordered_probe",
              execute,
            })
          : {
              name: "ordered_probe",
              label: "Ordered probe",
              description: "A tool whose operations cannot overlap.",
              parameters: Type.Object({}),
              execute,
            };
      tool.executionMode = "sequential";
      const ctx = createHeadlessCodeModeHarness([tool]);
      const call = source === "mcp" ? "MCP.probe.orderedProbe({})" : "ordered_probe({})";
      const code = `const values = await Promise.all([${call}, ${call}]); return ${source === "mcp" ? "values.map(value => value.structuredContent)" : "values"};`;
      const result =
        surface === "headless"
          ? await runCodeModeScriptHeadless({ ctx, code })
          : resultDetails(
              await expectDefined(createCodeModeTools(ctx)[0], "Code Mode exec").execute(
                "ordered-call",
                { code },
              ),
            );

      expect(result).toMatchObject({ status: "completed", value: [{ ok: true }, { ok: true }] });
      expect(calls).toBe(2);
      expect(maximumActive).toBe(1);
      expect(active).toBe(0);
    },
  );
});
