// Tool schema quarantine tests cover diagnostic logging for unreadable runtime
// tool entries without touching the broken tool object again.
import { describe, expect, it } from "vitest";
import { logRuntimeToolSchemaQuarantine } from "./tool-schema-quarantine.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("runtime tool schema quarantine logging", () => {
  it("does not re-read unreadable tool entries while logging diagnostics", () => {
    const tools = new Proxy([] as AnyAgentTool[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      logRuntimeToolSchemaQuarantine({
        diagnostics: [
          {
            toolName: "tool[0]",
            toolIndex: 0,
            violations: ["tool[0] is unreadable"],
          },
        ],
        tools,
        runId: "run-fuzzplugin-unreadable-tool",
      }),
    ).not.toThrow();
  });
});
