import { render } from "lit";
import { expect, it } from "vitest";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

it("surfaces agent config save errors in the active panel", () => {
  const container = document.createElement("div");
  render(
    renderAgents(
      createAgentViewTestProps({
        config: {
          form: { agents: { entries: { beta: {} } } },
          loading: false,
          saving: false,
          dirty: true,
          error: "mock validation failure",
        },
      }),
    ),
    container,
  );

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("mock validation failure");
});
