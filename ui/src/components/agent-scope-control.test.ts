/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentSelectionCapability } from "../app/agent-selection.ts";
import { renderAgentScopeControl } from "./agent-scope-control.ts";

describe("renderAgentScopeControl", () => {
  it("includes historical agent ids that are absent from the configured roster", () => {
    const container = document.createElement("div");
    const setScope = vi.fn();
    const selection = {
      state: { selectedId: "main", scopeId: null },
      set: vi.fn(),
      setScope,
      subscribe: vi.fn(),
    } as unknown as AgentSelectionCapability;

    render(
      renderAgentScopeControl({
        agents: [{ id: "main", name: "Main agent" }],
        additionalAgentIds: ["retired"],
        selection,
      }),
      container,
    );

    const select = container.querySelector("select");
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "main",
      "retired",
    ]);

    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("expected agent scope select");
    }
    select.value = "retired";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setScope).toHaveBeenCalledWith("retired");
  });
});
