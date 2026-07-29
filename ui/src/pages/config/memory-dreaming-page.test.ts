/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import "./memory-dreaming-page.ts";

type DreamsPageElement = HTMLElement & {
  agentId: string | null;
  agents: Array<{ value: string; label: string }>;
  onAgentChange: (agentId: string | null) => void;
  updateComplete: Promise<unknown>;
};

describe("MemoryDreamingSettings", () => {
  it("hosts the page-level agent picker without global config", async () => {
    const onAgentChange = vi.fn();
    const element = document.createElement("openclaw-memory-dreaming") as DreamsPageElement;
    element.agentId = null;
    element.agents = [
      { value: "main", label: "Main" },
      { value: "research", label: "Research" },
    ];
    element.onAgentChange = onAgentChange;
    document.body.append(element);
    try {
      await element.updateComplete;
      expect(element.querySelector("openclaw-agent-memory-panel")).toBeNull();
      expect(element.textContent).not.toContain("Dreaming frequency");

      const select = element.querySelector("openclaw-agent-select") as HTMLElement & {
        onSelect?: (value: string) => void;
      };
      select.onSelect?.("main");
      expect(onAgentChange).toHaveBeenCalledWith("main");
    } finally {
      element.remove();
    }
  });
});
