// Control UI tests cover the agents overview context display.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { MultiSelect } from "../../components/multi-select.ts";
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

describe("fallback field", () => {
  const primary = "openai/gpt-5.4";
  const existingFallback = "anthropic/claude-sonnet-4-6";
  const catalog = [
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
    { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google" },
  ] satisfies ReturnType<typeof createProps>["modelCatalog"];

  function renderFallbacks(overrides: Partial<ReturnType<typeof createProps>> = {}) {
    const container = document.createElement("div");
    const onModelFallbacksChange = vi.fn();
    render(
      renderAgents(
        createProps({
          config: {
            form: {
              agents: {
                defaults: { model: { primary, fallbacks: [existingFallback] } },
                entries: { alpha: {}, beta: {} },
              },
            },
            loading: false,
            saving: false,
            dirty: false,
            error: null,
          },
          modelCatalog: catalog,
          onModelFallbacksChange,
          ...overrides,
        }),
      ),
      container,
    );
    const field = container.querySelector<MultiSelect>("openclaw-multi-select.agent-fallbacks");
    if (!field) {
      throw new Error("fallback field missing");
    }
    return { field, onModelFallbacksChange };
  }

  it("hands the field the effective chain, the catalog, and the primary to exclude", () => {
    const { field } = renderFallbacks();

    expect(field.value).toEqual([existingFallback]);
    expect(field.exclude).toEqual([primary]);
    expect(field.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([primary, existingFallback, "google/gemini-3-pro"]),
    );
    expect(field.allowCustom).toBe(true);
    expect(field.disabled).toBe(false);
  });

  it("stages the field's next chain for the selected agent", () => {
    const { field, onModelFallbacksChange } = renderFallbacks();

    field.onChange([existingFallback, "google/gemini-3-pro"]);

    expect(onModelFallbacksChange).toHaveBeenCalledWith("beta", [
      existingFallback,
      "google/gemini-3-pro",
    ]);
  });

  it("disables the field without config write access", () => {
    const access = { ...createProps().access, canUpdateConfig: false };
    const { field } = renderFallbacks({ access });

    expect(field.disabled).toBe(true);
  });
});
