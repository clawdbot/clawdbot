// Control UI tests cover the agents overview context display.
import { render } from "lit";
import { expect, it } from "vitest";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

it.each([
  { label: "a read-only editor", canUpdateIdentity: false, identitySaving: false, text: "Save" },
  {
    label: "an active identity save",
    canUpdateIdentity: true,
    identitySaving: true,
    text: "Saving…",
  },
])("shows the actual save state for $label", ({ canUpdateIdentity, identitySaving, text }) => {
  const container = document.createElement("div");
  const props = createProps();
  render(
    renderAgents({
      ...props,
      access: { ...props.access, canUpdateIdentity },
      identitySaving,
    }),
    container,
  );

  const save = container.querySelector<HTMLButtonElement>(".agent-identity-editor__actions button");
  expect(save?.textContent?.trim()).toBe(text);
  expect(save?.disabled).toBe(true);
});

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
