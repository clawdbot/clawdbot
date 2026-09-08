/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { activationTargetId } from "./state.ts";
import { detected, mount, props, text } from "./test-helpers/view.test-support.ts";
import { renderModelSetup } from "./view.ts";

describe("Model Setup activation feedback", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
  });
  it.each([{ canAdmin: false }, { gatewayTooOld: true }])(
    "keeps activation feedback behind setup access: %j",
    (access) => {
      const container = mount(
        props({
          ...access,
          activation: {
            phase: "failure",
            targetId: "manual:openai",
            status: "auth",
            error: "Credential rejected",
          },
        }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(text(container)).not.toContain("Credential rejected");
    },
  );
  it.each([
    { entry: "discovered", targetId: activationTargetId("codex-cli", "openai/gpt-5") },
    { entry: "manual", targetId: "manual:openai" },
    {
      entry: "prepared but undiscovered",
      targetId: activationTargetId("provider-auto:ollama", "ollama/qwen3:4b"),
    },
  ])(
    "keeps one activation status and failure visible for $entry targets",
    ({ entry, targetId }) => {
      const viewProps = props({
        activation: { phase: "testing", targetId },
        actionsDisabled: true,
        manualApiKey: "test-only-secret",
      });
      const container = mount(viewProps);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(text(container.querySelector('[role="status"]')!)).toContain("Testing");
      expect(text(container)).not.toContain("test-only-secret");
      const button = container.querySelector<HTMLButtonElement>(
        entry === "discovered"
          ? '[data-candidate-kind="codex-cli"] button'
          : ".model-setup__manual .btn.primary",
      )!;
      expect(button.disabled).toBe(true);
      if (entry !== "prepared but undiscovered") {
        expect(text(button)).toBe("Testing…");
      }

      viewProps.activation = {
        phase: "failure",
        targetId,
        status: "timeout",
        error: "No reply received",
      };
      viewProps.actionsDisabled = false;
      render(renderModelSetup(viewProps), container);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(text(container.querySelector('[role="alert"]')!)).toContain("No reply received");
      expect(text(container.querySelector('[role="alert"]')!)).toContain(
        "Warm it or choose a faster model, then retry.",
      );
      expect(button.disabled).toBe(false);
      if (entry === "discovered") {
        expect(text(button)).toBe("Retry test");
        button.click();
        expect(viewProps.onActivateCandidate).toHaveBeenCalledWith(detected.candidates[0]);
      } else if (entry === "manual") {
        expect(text(button)).toBe("Connect & verify");
        button.click();
        expect(viewProps.onManualConnect).toHaveBeenCalledOnce();
      }

      viewProps.page = { phase: "ready", result: { ...detected, candidates: [] } };
      viewProps.manualProviderId = "gemini-api-key";
      render(renderModelSetup(viewProps), container);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(text(container.querySelector('[role="alert"]')!)).toContain("No reply received");
      viewProps.page = { phase: "loading" };
      render(renderModelSetup(viewProps), container);
      expect(text(container.querySelector('[role="alert"]')!)).toContain("No reply received");
      viewProps.page = { phase: "ready", result: { ...detected, candidates: [] } };
      viewProps.activation = { phase: "testing", targetId };
      render(renderModelSetup(viewProps), container);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    },
  );
});
