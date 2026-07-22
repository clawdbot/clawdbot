/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { renderAgentScopeControl } from "./agent-scope-control.ts";
import type { AgentSelectOption } from "./agent-select.ts";

type AgentSelectElement = HTMLElement & {
  options: AgentSelectOption[];
  value: string;
  onSelect: (value: string) => void;
  updateComplete: Promise<boolean>;
};

function createSelection(setScope: (agentId: string | null) => void) {
  return {
    state: { selectedId: "main", scopeId: null },
    set: vi.fn(),
    setScope,
    subscribe: vi.fn(),
  } as unknown as AgentSelectionCapability;
}

describe("renderAgentScopeControl", () => {
  it("includes historical agent ids and maps All agents back to null", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const setScope = vi.fn();

    render(
      renderAgentScopeControl({
        agents: [{ id: "main", name: "Main agent", identity: { emoji: "🦞" } }],
        additionalAgentIds: ["retired"],
        selection: createSelection(setScope),
      }),
      container,
    );

    const select = container.querySelector<AgentSelectElement>("openclaw-agent-select");
    expect(select).not.toBeNull();
    await select?.updateComplete;
    expect(select?.options.map((option) => option.value)).toEqual(["", "main", "retired"]);
    expect(select?.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "🦞",
    );

    select?.onSelect("retired");
    select?.onSelect("");
    expect(setScope).toHaveBeenNthCalledWith(1, "retired");
    expect(setScope).toHaveBeenNthCalledWith(2, null);
    container.remove();
  });

  it("supports a concrete-agent selector without an all-agents option", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const setScope = vi.fn();

    render(
      renderAgentScopeControl({
        agents: [
          { id: "main", name: "Main agent" },
          { id: "writer", name: "Writer" },
        ],
        selection: createSelection(setScope),
        allowAll: false,
        selectedId: "writer",
      }),
      container,
    );

    const select = container.querySelector<AgentSelectElement>("openclaw-agent-select");
    expect(select?.value).toBe("writer");
    expect(select?.options.map((option) => option.value)).toEqual(["main", "writer"]);
    select?.onSelect("main");
    expect(setScope).toHaveBeenCalledWith("main");
    container.remove();
  });
});
