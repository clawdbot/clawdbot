/** Receipt-grade facts for one model route that reached exact run admission. */
import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { recordExecutionDecisionWork } from "../audit/execution-decision-work.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import type { FailoverReason } from "./failover/signal.js";

type ModelRoutingSelectionMode = "automatic" | "explicit";

function boundedModelRef(provider: string, model: string): string {
  return truncateUtf16Safe(redactSensitiveText(`${provider}/${model}`, { mode: "tools" }), 160);
}

/** Queue only selected routes that already own an admitted execution token. */
export function recordAdmittedModelRoutingDecision(params: {
  admittedRunContext?: AdmittedRunContext;
  abortSignal?: AbortSignal;
  requestedProvider: string;
  requestedModel: string;
  selectedProvider: string;
  selectedModel: string;
  selectionMode: ModelRoutingSelectionMode;
  credentialProfileId?: string;
  fallbackSelected?: boolean;
  fallbackReason?: FailoverReason | null;
  occurredAt?: number;
}): boolean {
  const admittedRunContext = params.admittedRunContext;
  const token = admittedRunContext?.executionIdentityToken;
  if (!token) {
    return false;
  }
  const receiptId = `model-routing:${randomUUID()}`;
  const requestedRef = boundedModelRef(params.requestedProvider, params.requestedModel);
  const selectedRef = boundedModelRef(params.selectedProvider, params.selectedModel);
  const credentialProfileId = params.credentialProfileId?.trim();
  const hasCredentialOwner = Boolean(credentialProfileId);
  const reasonCode =
    params.fallbackReason ??
    (params.fallbackSelected ? "model_route_selected_after_fallback" : "model_route_selected");
  const assertActive = resolveAdmittedRunActiveAssertion(admittedRunContext, params.abortSignal);
  if (!assertActive) {
    throw new Error("admitted run authority is no longer active");
  }
  assertActive();
  return recordExecutionDecisionWork({
    workVersion: 1,
    token,
    receipt: {
      schemaVersion: 1,
      receiptId,
      occurredAt: params.occurredAt ?? Date.now(),
      action: {
        family: "model-routing",
        operation: `${params.selectionMode}-selection`,
        summary: `Requested ${requestedRef}; selected ${selectedRef}.`,
      },
      decision: {
        outcome: "allowed",
        reasonCode,
      },
      enforcement: {
        coverageState: hasCredentialOwner ? "attribution-only" : "unknown",
        policyRefs: [],
        grantRefs: [],
        contextFieldsUsed: ["contextId", "executionId", "runId"],
      },
      source: {
        owner: "model-routing",
        recordRef: receiptId,
        decisionBoundary: "agent-runtime.post-admission",
      },
      missingEvidence: hasCredentialOwner ? [] : ["credential_profile_owner"],
      remediation: [],
    },
    refs: {
      ...(credentialProfileId
        ? {
            resource: {
              namespace: "credential-profile" as const,
              value: credentialProfileId,
            },
          }
        : {}),
      target: {
        namespace: "model-route",
        value: JSON.stringify([params.selectedProvider, params.selectedModel]),
      },
    },
  });
}
