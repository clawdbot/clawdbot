import { describe, expect, it } from "vitest";
import type { WizardStep } from "../../api/types.ts";
import {
  activationTimeoutForKind,
  initialWizardValue,
  mapActivationResult,
  mapVerifyResult,
  wizardStateFromResult,
} from "./state.ts";

describe("model setup state", () => {
  it("selects the extended activation timeout only for Codex CLI", () => {
    expect(activationTimeoutForKind("codex-cli")).toBe(480_000);
    expect(activationTimeoutForKind("claude-cli")).toBe(150_000);
    expect(activationTimeoutForKind("api-key")).toBe(150_000);
  });

  it("maps activation success and categorized failure results", () => {
    expect(
      mapActivationResult({
        result: { ok: true, modelRef: "openai/gpt-5", latencyMs: 84, lines: [] },
        targetId: "openai",
        fallbackError: "failed",
      }),
    ).toEqual({ phase: "success", modelRef: "openai/gpt-5", latencyMs: 84 });
    expect(
      mapActivationResult({
        result: { ok: false, status: "billing", error: "No credits" },
        targetId: "openai",
        fallbackError: "failed",
      }),
    ).toEqual({ phase: "failure", targetId: "openai", status: "billing", error: "No credits" });
    expect(
      mapActivationResult({
        result: { ok: false },
        targetId: "openai",
        fallbackError: "failed",
      }),
    ).toEqual({ phase: "failure", targetId: "openai", status: "unknown", error: "failed" });
  });

  it("maps connection verification success and failure results", () => {
    expect(mapVerifyResult({ ok: true, modelRef: "openai/gpt-5", latencyMs: 84 })).toEqual({
      phase: "ok",
      modelRef: "openai/gpt-5",
      latencyMs: 84,
    });
    expect(mapVerifyResult({ ok: false, status: "rate_limit", error: "Try later" })).toEqual({
      phase: "failed",
      status: "rate_limit",
      error: "Try later",
    });
  });

  it("transitions wizard results through step, validation, done, cancelled, and error", () => {
    const step: WizardStep = {
      id: "provider",
      type: "select",
      options: [{ value: "openai", label: "OpenAI" }],
      initialValue: "openai",
    };
    expect(wizardStateFromResult("oauth", { done: false, step }, "failed")).toEqual({
      phase: "step",
      authChoice: "oauth",
      step,
      busy: false,
      validationError: null,
    });
    expect(
      wizardStateFromResult("oauth", { done: false, step, error: "Pick one" }, "failed"),
    ).toMatchObject({ phase: "step", validationError: "Pick one" });
    expect(wizardStateFromResult("oauth", { done: true, status: "done" }, "failed")).toEqual({
      phase: "done",
      authChoice: "oauth",
    });
    expect(
      wizardStateFromResult("oauth", { done: true, status: "cancelled" }, "Cancelled"),
    ).toEqual({ phase: "cancelled", message: "Cancelled" });
    expect(
      wizardStateFromResult(
        "oauth",
        { done: true, status: "error", error: "Provider rejected login" },
        "failed",
      ),
    ).toEqual({ phase: "error", message: "Provider rejected login" });
  });

  it("copies multiselect initial values", () => {
    const initial = ["a"];
    const value = initialWizardValue({ id: "models", type: "multiselect", initialValue: initial });
    expect(value).toEqual(["a"]);
    expect(value).not.toBe(initial);
  });
});
