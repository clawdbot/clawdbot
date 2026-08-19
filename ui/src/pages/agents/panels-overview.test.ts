// Control UI tests cover the agents overview context display.
import { render } from "lit";
import { expect, it } from "vitest";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

it("shows inherited skills in the Agent Context overview", () => {
  const container = document.createElement("div");
  render(
    renderAgents(
      createProps({
        config: {
          form: {
            agents: {
              defaults: { skills: ["github", "weather"] },
              entries: { beta: {} },
            },
          },
          loading: false,
          saving: false,
          dirty: false,
          error: null,
        },
      }),
    ),
    container,
  );

  const skillsFilterRow = Array.from(container.querySelectorAll("dt")).find(
    (term) => term.textContent?.trim() === "Skills Filter",
  )?.nextElementSibling;
  expect(skillsFilterRow?.textContent?.trim()).toBe("2 selected");
});
