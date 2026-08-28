// Control UI tests cover the agents overview context display.
import { render } from "lit";
import { expect, it } from "vitest";
import { buildAgentContext } from "../../lib/agents/display.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

const inheritedAgentModel = "openai/gpt-5.4";
const resolvedAgentWorkspace = "/tmp/agents/beta";

it.each([
  {
    name: "inherits a primary while preserving agent-owned fallbacks",
    model: { fallbacks: ["google/gemini-3-pro"] },
    expectedModel: `${inheritedAgentModel} (+1 fallback)`,
  },
  {
    name: "preserves explicitly disabled agent fallbacks",
    model: { fallbacks: [] },
    expectedModel: inheritedAgentModel,
  },
  {
    name: "prefers a dirty agent primary over stale roster and global models",
    model: { primary: "anthropic/claude-sonnet-4-6" },
    expectedModel: "anthropic/claude-sonnet-4-6",
  },
])("buildAgentContext $name", ({ model, expectedModel }) => {
  const context = buildAgentContext(
    {
      id: "beta",
      workspace: resolvedAgentWorkspace,
      model: { primary: "openai/stale-roster-model", fallbacks: ["openai/stale-fallback"] },
    },
    {
      agents: {
        defaults: {
          workspace: "/tmp/agents",
          model: { primary: inheritedAgentModel, fallbacks: ["openai/global-fallback"] },
        },
        entries: { beta: { model } },
      },
    },
    null,
    "alpha",
  );

  expect(context.workspace).toBe(resolvedAgentWorkspace);
  expect(context.model).toBe(expectedModel);
});

it.each(["overview", "channels", "cron"] as const)(
  "shows authoritative agent workspace and effective model on the %s panel",
  (activePanel) => {
    const container = document.createElement("div");
    const props = createProps();
    render(
      renderAgents({
        ...props,
        activePanel,
        agentsList: {
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "alpha", name: "Alpha" },
            {
              id: "beta",
              name: "Beta",
              workspace: resolvedAgentWorkspace,
              model: { primary: inheritedAgentModel },
            },
          ],
        },
        config: {
          ...props.config,
          form: {
            agents: {
              defaults: {
                workspace: "/tmp/agents",
                model: { primary: inheritedAgentModel, fallbacks: ["openai/global-fallback"] },
              },
              entries: { beta: { model: { fallbacks: ["google/gemini-3-pro"] } } },
            },
          },
        },
      }),
      container,
    );

    const contextValue = (label: string) =>
      Array.from(container.querySelectorAll("dt"))
        .find((term) => term.textContent?.trim() === label)
        ?.nextElementSibling?.textContent?.trim();

    expect(contextValue("Workspace")).toBe(resolvedAgentWorkspace);
    expect(contextValue("Primary Model")).toBe(`${inheritedAgentModel} (+1 fallback)`);
  },
);

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
