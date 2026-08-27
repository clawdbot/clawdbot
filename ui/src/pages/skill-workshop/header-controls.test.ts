/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSkillWorkshopHeaderControls } from "./header-controls.ts";
import { createSkillWorkshopState } from "./proposals.ts";

describe("skill workshop header tabs", () => {
  it("renders the active mode and selects a different view", () => {
    const state = createSkillWorkshopState();
    const requestUpdate = vi.fn();
    const container = document.createElement("div");
    render(
      renderSkillWorkshopHeaderControls(
        state,
        { selfLearning: null, onSelfLearningToggle: () => undefined },
        requestUpdate,
      ),
      container,
    );

    expect(container.querySelector("#skill-workshop-mode-tab-today")?.hasAttribute("active")).toBe(
      true,
    );
    container
      .querySelector("#skill-workshop-mode-tab-board")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(state.skillWorkshopMode).toBe("board");
    expect(requestUpdate).toHaveBeenCalledOnce();
  });
});
