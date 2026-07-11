// Classifies whether a user's chat message approves a pending Crestodian proposal.
import { extractAssistantText } from "../agents/embedded-agent-utils.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import {
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceBinding,
} from "./verified-inference.js";

/**
 * Approval detection for pending mutations. The host — not the conversation
 * model — decides whether a turn is armed, so the agent loop can never
 * self-approve (see crestodian-tool.ts). Users approve in their own words:
 * unambiguous replies resolve instantly from a closed list, everything else is
 * judged by a separate single-shot model call that sees only the user's
 * message and the proposal description, never tool output. When no completion
 * model is usable the closed list is the whole decision — "other" (the safe
 * default) keeps the proposal pending and the conversation re-asks.
 */
export type CrestodianApprovalIntent = "approve" | "decline" | "other";

export type CrestodianApprovalClassifier = (params: {
  message: string;
  /** Human-readable proposal description when the host knows it. */
  proposal?: string;
  /** Exact execution owner that completed the live Crestodian inference gate. */
  verifiedInference: CrestodianVerifiedInferenceBinding;
}) => Promise<CrestodianApprovalIntent>;

const APPROVAL_INTENT_TIMEOUT_MS = 10_000;
const APPROVAL_INTENT_MAX_TOKENS = 8;

// Approvals arm a mutation, so the deterministic list is whole-message only;
// declines merely drop a proposal, so a leading match ("no thanks") suffices.
const APPROVE_RE =
  /^(?:y|yes|yeah|yep|yup|sure|ok|okay|approve|approved|apply|confirm|confirmed|do it|go ahead|sounds good|yes please|please do)$/i;
const DECLINE_RE = /^(?:n|no|nope|nah|skip|not now|cancel|stop|abort|later|decline|don'?t)\b/i;

function normalizeApprovalText(message: string): string {
  return message
    .trim()
    .replace(/[.!?,\s]+$/u, "")
    .toLowerCase();
}

/** Closed-list classification: exact affirmatives, prefix declines. */
export function classifyCrestodianApprovalText(message: string): CrestodianApprovalIntent {
  const normalized = normalizeApprovalText(message);
  if (!normalized) {
    return "other";
  }
  if (APPROVE_RE.test(normalized)) {
    return "approve";
  }
  if (DECLINE_RE.test(normalized)) {
    return "decline";
  }
  return "other";
}

const APPROVAL_INTENT_SYSTEM_PROMPT = [
  "You classify one chat message from a user who was just asked to approve a pending configuration change.",
  "Reply with exactly one word:",
  "approve — the message clearly consents to applying the pending change now.",
  "decline — the message clearly rejects or postpones the pending change.",
  "other — anything else: questions, new requests, partial or conditional agreement, or unclear intent.",
  "Only classify consent for the pending change itself. A message asking to change the proposal is not approval.",
].join("\n");

export type CrestodianApprovalIntentDeps = {
  resolveVerifiedInferenceRoute?: typeof resolveCrestodianVerifiedInferenceRoute;
  prepareSimpleCompletionModelForAgent?: typeof prepareSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel?: typeof completeWithPreparedSimpleCompletionModel;
};

/**
 * Judge whether a message approves the pending proposal. Closed-list answers
 * short-circuit so a literal "yes" cannot be reinterpreted by the conversation
 * model; ambiguous messages go to a separate configured completion call.
 * CLI-harness routes do not spawn a second harness for that check, so their
 * ambiguous replies stay "other" and the conversation asks for a clear yes.
 */
export async function classifyCrestodianApprovalIntent(
  params: {
    message: string;
    proposal?: string;
    verifiedInference: CrestodianVerifiedInferenceBinding;
  },
  deps: CrestodianApprovalIntentDeps = {},
): Promise<CrestodianApprovalIntent> {
  const textIntent = classifyCrestodianApprovalText(params.message);
  if (textIntent !== "other") {
    return textIntent;
  }
  try {
    const resolveVerifiedRoute =
      deps.resolveVerifiedInferenceRoute ?? resolveCrestodianVerifiedInferenceRoute;
    const route = await resolveVerifiedRoute(params.verifiedInference);
    // A second direct completion would bypass CLI and plugin-harness execution
    // ownership. Those routes require an exact closed-list approval instead.
    if (!route || route.runner !== "embedded" || route.agentHarnessRuntimeOverride !== "openclaw") {
      return "other";
    }
    const modelRef = route.authProfileId
      ? `${route.modelLabel}@${route.authProfileId}`
      : route.modelLabel;
    const prepared = await (
      deps.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent
    )({
      cfg: route.runConfig,
      agentId: route.agentId,
      agentDir: route.agentDir,
      modelRef,
      ...(route.authProfileId ? { preferredProfile: route.authProfileId } : {}),
      allowMissingApiKeyModes: ["aws-sdk"],
      bindAuthOwner: true,
    });
    if ("error" in prepared) {
      return "other";
    }
    const preparedProvider = prepared.selection.runtimeProvider ?? prepared.selection.provider;
    if (
      preparedProvider !== route.provider ||
      prepared.selection.modelId !== route.model ||
      prepared.selection.agentDir !== route.agentDir ||
      prepared.selection.profileId !== route.authProfileId ||
      prepared.auth.profileId !== route.authProfileId ||
      !params.verifiedInference.auth.authFingerprint ||
      prepared.sourceAuthFingerprint !== params.verifiedInference.auth.authFingerprint
    ) {
      return "other";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APPROVAL_INTENT_TIMEOUT_MS);
    try {
      const response = await (
        deps.completeWithPreparedSimpleCompletionModel ?? completeWithPreparedSimpleCompletionModel
      )({
        model: prepared.model,
        auth: prepared.auth,
        cfg: route.runConfig,
        context: {
          systemPrompt: APPROVAL_INTENT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                `Pending change: ${params.proposal ?? "a configuration change proposed in this conversation"}`,
                `User message: ${params.message}`,
              ].join("\n"),
              timestamp: Date.now(),
            },
          ],
        },
        options: {
          maxTokens: APPROVAL_INTENT_MAX_TOKENS,
          signal: controller.signal,
        },
      });
      if (!(await resolveVerifiedRoute(params.verifiedInference))) {
        return "other";
      }
      const verdict = extractAssistantText(response)?.trim().toLowerCase().split(/\s+/)[0];
      if (verdict === "approve" || verdict === "decline") {
        return verdict;
      }
      return "other";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Approval must fail closed: an unreachable model means no arming.
    return "other";
  }
}
