import { describe, expect, it } from "vitest";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";

describe("SystemAgentInferenceUnavailableError", () => {
  it("keeps onboarding guidance when no failure detail is available", () => {
    expect(new SystemAgentInferenceUnavailableError("conversation").message).toContain(
      "openclaw onboard",
    );
  });

  it.each([
    "Managed policy prevents this runtime configuration. Contact the policy administrator.",
    "Inference request timed out. Try again.",
  ])("preserves actionable failure detail without prescribing reconnection: %s", (detail) => {
    const error = new SystemAgentInferenceUnavailableError("agent-turn", [new Error(detail)]);

    expect(error.message).toContain(detail);
    expect(error.message).not.toContain("openclaw onboard");
    expect(error.message).not.toContain("reconnect");
  });

  it.each(["instance", "code"])(
    "preserves the first failure through nested %s wrappers without repeated guidance",
    (representation) => {
      const detail = `${"Runtime policy context. ".repeat(8)}Contact the policy administrator.`;
      const original = new SystemAgentInferenceUnavailableError("agent-turn", [new Error(detail)]);
      const first =
        representation === "instance"
          ? original
          : Object.assign(new Error(original.message), { code: original.code });
      const planner = new SystemAgentInferenceUnavailableError("planner", [first]);
      const conversation = new SystemAgentInferenceUnavailableError("conversation", [
        planner,
        new Error("Later planner failure"),
      ]);

      expect(conversation.message).toBe(original.message);
      expect(conversation.message).toContain(detail);
      expect(conversation.stage).toBe("conversation");
      expect(conversation.failures[0]).toBe(planner);
    },
  );

  it("bounds root detail without splitting a UTF-16 surrogate pair", () => {
    const error = new SystemAgentInferenceUnavailableError("agent-turn", [
      new Error(`${"a".repeat(298)}🦞remaining detail`),
    ]);
    const summary = error.message.split("Cause: ")[1];

    expect(summary).toBe(`${"a".repeat(298)}…`);
  });
});
