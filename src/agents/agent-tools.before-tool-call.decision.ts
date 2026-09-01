import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { recordExecutionDecisionWork } from "../audit/execution-decision-work.js";
import { getAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./tools/common.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const genericDecisions = {
  allowed: ["allowed", "attribution-only", "generic_action_attributed"],
  denied: ["denied", "enforced", "generic_action_policy_denied"],
  suppressed: ["not-applicable", "attribution-only", "generic_action_suppressed"],
} as const;
const toolDecisionOwner = new AsyncLocalStorage<{ recorded: boolean }>();

/** Marks the current tool call after its owner-native decision record is registered. */
export function markToolDecisionRecorded(): void {
  const state = toolDecisionOwner.getStore();
  if (state) {
    state.recorded = true;
  }
}

/** Records generic attribution only when execution creates no owner-native record. */
export async function runWithGenericToolActionDecision<T>(
  tool: AnyAgentTool,
  toolCallId: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const state = { recorded: false };
  try {
    return await toolDecisionOwner.run(state, run);
  } finally {
    if (!state.recorded) {
      recordGenericToolActionDecision(tool, toolCallId, "allowed");
    }
  }
}

export function recordGenericToolActionDecision(
  tool: AnyAgentTool,
  toolCallId: string | undefined,
  kind: keyof typeof genericDecisions,
): boolean {
  const descriptor = getAgentToolActionDescriptor(tool);
  const identity = getGatewayToolCallerIdentity();
  const token = identity?.executionIdentityToken;
  const authority = identity?.receiptAuthority;
  if (!descriptor || !toolCallId?.trim() || !token || !authority) {
    return false;
  }
  const [outcome, coverageState, reasonCode] = genericDecisions[kind];
  const receiptId = `tool-action:${createHash("sha256")
    .update(
      JSON.stringify([token.contextId, token.executionId, toolCallId, descriptor, reasonCode]),
    )
    .digest("base64url")
    .slice(0, 32)}`;
  try {
    const occurredAt = Date.now();
    if (authority() === false) {
      return false;
    }
    return recordExecutionDecisionWork({
      workVersion: 1,
      token,
      receipt: {
        schemaVersion: 1,
        receiptId,
        occurredAt,
        action: descriptor,
        decision: { outcome, reasonCode },
        enforcement: {
          coverageState,
          policyRefs: kind === "denied" ? ["tool-action-policy"] : [],
          grantRefs: [],
          contextFieldsUsed: ["contextId", "executionId", "runId"],
        },
        source: {
          owner: "tool-action",
          recordRef: receiptId,
          decisionBoundary: "agent-tool.before-execute",
        },
        missingEvidence: [],
        remediation: [],
      },
    });
  } catch {
    return false;
  }
}
