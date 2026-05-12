import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { SessionSchema } from "./zod-schema.session.js";

describe("typing mode schema reuse", () => {
  it("accepts supported typingMode values for session and agent defaults", () => {
    const session = SessionSchema.parse({ typingMode: "thinking" });
    const agentDefaults = AgentDefaultsSchema.parse({ typingMode: "message" });
    expect(session?.typingMode).toBe("thinking");
    expect(agentDefaults?.typingMode).toBe("message");
  });

  it("rejects unsupported typingMode values for session and agent defaults", () => {
    const sessionResult = SessionSchema.safeParse({ typingMode: "always" });
    const agentDefaultsResult = AgentDefaultsSchema.safeParse({ typingMode: "soon" });

    expect(sessionResult.success).toBe(false);
    expect(agentDefaultsResult.success).toBe(false);
    if (sessionResult.success || agentDefaultsResult.success) {
      throw new Error("Expected unsupported typingMode values to fail schema validation.");
    }
    expect(sessionResult.error.issues.map((issue) => issue.path.join("."))).toContain("typingMode");
    expect(agentDefaultsResult.error.issues.map((issue) => issue.path.join("."))).toContain(
      "typingMode",
    );
  });
});
