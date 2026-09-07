/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSkillWorkshopHeaderControls } from "./header-controls.ts";
import { createSkillWorkshopState } from "./proposals.ts";

describe("skill workshop header tabs", () => {
  it("renders Skills by default and reports the requested section", () => {
    const state = createSkillWorkshopState();
    const onModeChange = vi.fn();
    const container = document.createElement("div");
    render(
      renderSkillWorkshopHeaderControls(state, {
        selfLearning: null,
        onSelfLearningToggle: () => undefined,
        onModeChange,
      }),
      container,
    );

    expect(container.querySelector("#skill-workshop-mode-tab-skills")?.hasAttribute("active")).toBe(
      true,
    );
    container
      .querySelector("#skill-workshop-mode-tab-suggestions")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));

    expect(onModeChange).toHaveBeenCalledWith("suggestions");
  });
});
