// Verifies typing-mode schema parsing and defaults.
import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("typing mode schema reuse", () => {
  it("accepts supported typingMode values for agent defaults and entries", () => {
    const agent = AgentEntrySchema.parse({ id: "support", typingMode: "thinking" });
    const agentDefaults = AgentDefaultsSchema.parse({ typingMode: "message" });
    expect(agent.typingMode).toBe("thinking");
    expect(agentDefaults?.typingMode).toBe("message");
  });

  it("rejects unsupported typingMode values for agent defaults and entries", () => {
    const agentResult = AgentEntrySchema.safeParse({ id: "support", typingMode: "always" });
    const agentDefaultsResult = AgentDefaultsSchema.safeParse({ typingMode: "soon" });

    expect(agentResult.success).toBe(false);
    expect(agentDefaultsResult.success).toBe(false);
    if (agentResult.success || agentDefaultsResult.success) {
      throw new Error("Expected unsupported typingMode values to fail schema validation.");
    }
    expect(agentResult.error.issues.map((issue) => issue.path.join("."))).toEqual(["typingMode"]);
    expect(agentDefaultsResult.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "typingMode",
    ]);
  });
});
