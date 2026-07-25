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

  it("keeps semantic system agents out of roster and historical options", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderAgentScopeControl({
        agents: [
          { id: "main", kind: "agent", name: "Main agent" },
          { id: "ordinary-looking-id", kind: "system", name: "System" },
          { id: "writer", kind: "agent", name: "Writer" },
        ],
        additionalAgentIds: ["ordinary-looking-id", "retired"],
        selection: createSelection(vi.fn()),
        selectedId: "ordinary-looking-id",
      }),
      container,
    );

    const select = container.querySelector<AgentSelectElement>("openclaw-agent-select");
    await select?.updateComplete;
    expect(select?.value).toBe("");
    expect(select?.options.map((option) => option.value)).toEqual([
      "",
      "main",
      "retired",
      "writer",
    ]);
    container.remove();
  });

  it("uses the first selectable agent when a concrete selector receives a system id", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderAgentScopeControl({
        agents: [
          { id: "main", kind: "agent", name: "Main agent" },
          { id: "ordinary-looking-id", kind: "system", name: "System" },
          { id: "writer", kind: "agent", name: "Writer" },
        ],
        selection: createSelection(vi.fn()),
        allowAll: false,
        selectedId: "ordinary-looking-id",
      }),
      container,
    );

    const select = container.querySelector<AgentSelectElement>("openclaw-agent-select");
    await select?.updateComplete;
    expect(select?.value).toBe("main");
    expect(select?.options.map((option) => option.value)).toEqual(["main", "writer"]);
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
