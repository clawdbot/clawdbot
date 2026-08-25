import { afterEach, describe, expect, it } from "vitest";
import {
  configureExecutionDecisionWorkSink,
  type ExecutionDecisionWork,
} from "../audit/execution-decision-work.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { recordAdmittedModelRoutingDecision } from "./model-routing-decision.js";

afterEach(() => {
  configureExecutionDecisionWorkSink(() => false)();
});

describe("admitted model routing decisions", () => {
  it("keeps a selected credential raw only in the private work ref", () => {
    const captured: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((work) => {
      captured.push(work);
      return true;
    });
    const token = createExecutionIdentityAdmissionToken("model-route-run", {
      contextId: "model-route-context",
      executionId: "model-route-execution",
      now: 1_000,
    });
    const rawProfile = "openai:user@example.test";
    const rawTargetSecret = "Authorization: Bearer selected-model-secret";

    expect(
      recordAdmittedModelRoutingDecision({
        token,
        requestedProvider: "openai",
        requestedModel: "gpt-5.6",
        selectedProvider: "openai",
        selectedModel: rawTargetSecret,
        selectionMode: "explicit",
        credentialProfileId: rawProfile,
        fallbackReason: "rate_limit",
        occurredAt: 1_001,
      }),
    ).toBe(true);
    clear();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      token,
      receipt: {
        action: { family: "model-routing", operation: "explicit-selection" },
        decision: { reasonCode: "rate_limit" },
        enforcement: { coverageState: "attribution-only" },
      },
      refs: {
        resource: { namespace: "credential-profile", value: rawProfile },
        target: { namespace: "model-route" },
      },
    });
    expect(JSON.stringify(captured[0]?.receipt)).not.toContain(rawProfile);
    expect(JSON.stringify(captured[0]?.receipt)).not.toContain("selected-model-secret");
    expect(captured[0]?.refs?.target?.value).toContain(rawTargetSecret);
  });

  it("does not fabricate work without admission and marks an unknown credential owner", () => {
    const captured: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((work) => {
      captured.push(work);
      return true;
    });

    expect(
      recordAdmittedModelRoutingDecision({
        token: undefined,
        requestedProvider: "openai",
        requestedModel: "gpt-5.6",
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
        selectionMode: "automatic",
      }),
    ).toBe(false);
    expect(
      recordAdmittedModelRoutingDecision({
        token: createExecutionIdentityAdmissionToken("unknown-owner-run"),
        requestedProvider: "openai",
        requestedModel: "gpt-5.6",
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
        selectionMode: "automatic",
      }),
    ).toBe(true);
    clear();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.receipt).toMatchObject({
      enforcement: { coverageState: "unknown" },
      missingEvidence: ["credential_profile_owner"],
    });
    expect(captured[0]?.refs?.resource).toBeUndefined();
  });
});
