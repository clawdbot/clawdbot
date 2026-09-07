import { describe, expect, it, vi } from "vitest";
import { loadAgentRole } from "../agents/agent-roles.js";
import { buildNewAgentWelcome } from "./new-agent-welcome.js";

describe("buildNewAgentWelcome", () => {
  it("offers catalog roles in order, a team, and custom work before approval", async () => {
    const noteAssistantMessage = vi.fn();

    const welcome = await buildNewAgentWelcome({ engine: { noteAssistantMessage } });
    const choices = welcome.split("\n").slice(1);
    const roles = ["coordinator", "researcher", "writer", "reviewer"];
    for (const [index, role] of roles.entries()) {
      const { manifest } = await loadAgentRole(role);
      expect(choices[index]).toBe(
        `${index + 1}. ${manifest.agent.name} — ${manifest.agent.description}`,
      );
    }

    expect(choices).toHaveLength(6);
    expect(choices[4]).toContain("A small team (chief of staff plus the three specialists)");
    expect(choices[5]).toContain("Something custom (tell me the name and the kind of work)");
    expect(welcome).toContain("approval");
    expect(noteAssistantMessage).toHaveBeenCalledWith(welcome);
  });
});
