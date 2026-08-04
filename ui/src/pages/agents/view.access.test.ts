// Control UI tests cover agent access behavior.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

describe("renderAgents access", () => {
  it("keeps navigation readable while disabling unavailable mutations", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderAgents(
        createAgentViewTestProps({
          access: {
            canCreateAgent: false,
            canUpdateConfig: false,
            canUpdateIdentity: false,
            canWriteFiles: false,
            canRunCron: false,
          },
        }),
      ),
      container,
    );

    const select = container.querySelector("openclaw-agent-select") as
      | (HTMLElement & { onCreateAgent: (() => void) | null; updateComplete: Promise<boolean> })
      | null;
    await select?.updateComplete;
    expect(select?.querySelector(".agent-select__label")?.textContent?.trim()).toBe("Beta");
    expect(select?.onCreateAgent).toBeNull();
    const setDefault = container.querySelectorAll<HTMLButtonElement>(
      ".agents-toolbar-actions button",
    )[1];
    expect(setDefault?.disabled).toBe(true);
    container.remove();
  });
});
