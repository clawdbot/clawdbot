// Control UI tests cover agent-selector behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

describe("renderAgents agent selector", () => {
  it("hides the selector for one agent and keeps agent creation available", () => {
    const container = document.createElement("div");
    const onCreateAgent = vi.fn();
    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "alpha", name: "Alpha" }],
          },
          selectedAgentId: "alpha",
          onCreateAgent,
        }),
      ),
      container,
    );

    expect(container.querySelector(".agents-control-select")).toBeNull();
    const createButton = container.querySelector<HTMLButtonElement>(".agents-create-btn");
    expect(createButton?.textContent?.trim()).toBe(t("custodian.newAgent"));
    createButton?.click();
    expect(onCreateAgent).toHaveBeenCalledOnce();
  });
});
