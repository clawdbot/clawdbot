import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
  renderSessionObserverSettings,
} from "./session-observer-settings.ts";

describe("session observer settings patches", () => {
  it("uses null to restore the default toggle and false to opt out", () => {
    expect(buildSessionObserverTogglePatch(true)).toEqual({
      gateway: { controlUi: { sessionObserver: null } },
    });
    expect(buildSessionObserverTogglePatch(false)).toEqual({
      gateway: { controlUi: { sessionObserver: false } },
    });
  });

  it("distinguishes automatic, disabled, and explicit utility models", () => {
    expect(buildSessionObserverUtilityModelPatch({ kind: "auto" })).toEqual({
      agents: { defaults: { utilityModel: null } },
    });
    expect(buildSessionObserverUtilityModelPatch({ kind: "disabled" })).toEqual({
      agents: { defaults: { utilityModel: "" } },
    });
    expect(
      buildSessionObserverUtilityModelPatch({ kind: "model", model: "openai/gpt-5-mini" }),
    ).toEqual({
      agents: { defaults: { utilityModel: "openai/gpt-5-mini" } },
    });
  });

  it("keeps auto and disabled selectable when explicit models are unavailable", () => {
    const container = document.createElement("div");
    render(
      renderSessionObserverSettings({
        enabled: true,
        utilityModel: undefined,
        resolvedUtilityModel: { status: "unavailable" },
        models: [{ id: "gpt-mini", name: "GPT Mini", provider: "openai" }],
        modelsUnavailable: true,
        disabled: false,
        onEnabledChange: () => undefined,
        onUtilityModelChange: () => undefined,
      }),
      container,
    );

    const select = container.querySelector<HTMLSelectElement>("select");
    const options = [...(select?.options ?? [])];
    expect(select?.disabled).toBe(false);
    expect(options.find((option) => option.text === "Auto (provider default)")?.disabled).toBe(
      false,
    );
    expect(options.find((option) => option.text === "Disabled")?.disabled).toBe(false);
    expect(options.find((option) => option.text === "GPT Mini")?.disabled).toBe(true);
    expect(container.textContent).toContain("Explicit model catalog unavailable");
  });
});
