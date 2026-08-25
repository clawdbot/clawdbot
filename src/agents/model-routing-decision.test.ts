import { afterEach, describe, expect, it } from "vitest";
import {
  configureExecutionDecisionWorkSink,
  type ExecutionDecisionWork,
} from "../audit/execution-decision-work.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { recordAdmittedModelRoutingDecision } from "./model-routing-decision.js";

const auditConfig = {
  logging: { audit: { executionIdentity: true } },
} satisfies OpenClawConfig;

function prepareRoutingAdmission(runId: string) {
  return prepareAgentRunAdmission({
    cfg: auditConfig,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "model-routing-test", state: "present" },
    },
  });
}

afterEach(() => {
  configureExecutionDecisionWorkSink(() => false)();
});

describe("admitted model routing decisions", () => {
  it("keeps a selected credential raw only in the private work ref", async () => {
    const captured: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((work) => {
      captured.push(work);
      return true;
    });
    const admission = prepareRoutingAdmission("model-route-run");
    const admittedRunContext = await admission.admit("embedded");
    const token = admittedRunContext.executionIdentityToken;
    const rawProfile = "openai:user@example.test";
    const rawTargetSecret = "Authorization: Bearer selected-model-secret";

    expect(
      recordAdmittedModelRoutingDecision({
        admittedRunContext,
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
    admission.close();
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

  it("does not fabricate work without admission and marks an unknown credential owner", async () => {
    const captured: ExecutionDecisionWork[] = [];
    const clear = configureExecutionDecisionWorkSink((work) => {
      captured.push(work);
      return true;
    });

    expect(
      recordAdmittedModelRoutingDecision({
        requestedProvider: "openai",
        requestedModel: "gpt-5.6",
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
        selectionMode: "automatic",
      }),
    ).toBe(false);
    const admission = prepareRoutingAdmission("unknown-owner-run");
    const admittedRunContext = await admission.admit("embedded");
    expect(
      recordAdmittedModelRoutingDecision({
        admittedRunContext,
        requestedProvider: "openai",
        requestedModel: "gpt-5.6",
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
        selectionMode: "automatic",
      }),
    ).toBe(true);
    admission.close();
    clear();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.receipt).toMatchObject({
      enforcement: { coverageState: "unknown" },
      missingEvidence: ["credential_profile_owner"],
    });
    expect(captured[0]?.refs?.resource).toBeUndefined();
  });

  it.each(["close", "replace"] as const)(
    "rejects %s authority without queuing private work",
    async (loss) => {
      const runId = `model-route-${loss}`;
      const admission = prepareRoutingAdmission(runId);
      const admittedRunContext = await admission.admit("embedded");
      const replacement = loss === "replace" ? prepareRoutingAdmission(runId) : undefined;
      if (replacement) {
        await replacement.admit("embedded");
      } else {
        admission.close();
      }
      const captured: ExecutionDecisionWork[] = [];
      const clear = configureExecutionDecisionWorkSink((work) => {
        captured.push(work);
        return true;
      });

      expect(() =>
        recordAdmittedModelRoutingDecision({
          admittedRunContext,
          requestedProvider: "openai",
          requestedModel: "gpt-5.6",
          selectedProvider: "openai",
          selectedModel: "gpt-5.6",
          selectionMode: "automatic",
        }),
      ).toThrow("admitted run authority is no longer active");
      clear();
      admission.close();
      replacement?.close();

      expect(captured).toEqual([]);
    },
  );
});
