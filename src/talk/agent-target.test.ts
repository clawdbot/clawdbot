import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { resolveTalkSessionAgentId } from "./agent-target.js";

const explicitRoster = {
  agents: { list: [{ id: "main" }, { id: "molty" }] },
};

describe("resolveTalkSessionAgentId", () => {
  it("uses an agent-scoped session owner without requiring an ambient Talk default", () => {
    expect(resolveTalkSessionAgentId(explicitRoster, "agent:molty:talk:voice-1")).toBe("molty");
  });

  it("keeps ownerless Talk sessions as an explicit configuration error", () => {
    expect(() => resolveTalkSessionAgentId(explicitRoster, "global")).toThrow(
      AgentSelectionRequiredError,
    );
  });
});
