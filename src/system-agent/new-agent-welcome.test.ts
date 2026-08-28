import { describe, expect, it, vi } from "vitest";
import { buildNewAgentWelcome } from "./new-agent-welcome.js";

describe("buildNewAgentWelcome", () => {
  it("starts a purpose-and-name creation conversation", () => {
    const noteAssistantMessage = vi.fn();

    const welcome = buildNewAgentWelcome({ engine: { noteAssistantMessage } as never });

    expect(welcome).toContain("What should it be called");
    expect(welcome).toContain("what kind of work is it for");
    expect(welcome).toContain("learn its role during hatch");
    expect(welcome).toContain("approval");
    expect(noteAssistantMessage).toHaveBeenCalledWith(welcome);
  });
});
