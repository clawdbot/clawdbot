import { resolveActiveReplyOperationForSessionId } from "../../auto-reply/reply/reply-run-registry.js";
import { getAttachedBackend } from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  prepareReplyToolAuthority,
  type ReplyToolAuthorityInput,
} from "../../auto-reply/reply/reply-tool-authority.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import {
  createAgentQuestionAnswerAuthority,
  registerAgentHarnessQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "./host-private-capabilities.js";
import type { AgentHarnessAttemptParamsV2 } from "./types.js";

type ToolAuthorityAttempt = Pick<
  AgentHarnessAttemptParamsV2,
  | Exclude<
      keyof ReplyToolAuthorityInput["run"],
      "model" | "runtimePolicySessionKey" | "elevatedLevel" | "traceAuthorized"
    >
  | "modelId"
  | "sandboxSessionKey"
  | "messageChannel"
  | "toolsAllow"
  | "disableTools"
  | "runId"
  | "abortSignal"
  | "toolAuthorityFingerprint"
> & { hostCapabilities?: AgentHarnessAttemptParamsV2["hostCapabilities"] };

/** Execution-only: policy preparation must finish before authority reaches a publisher. */
export async function withPreparedEmbeddedRunToolAuthority<T, Attempt extends ToolAuthorityAttempt>(
  internal: Pick<EmbeddedRunAttemptInternalParams, "admittedRunContext" | "replyOperation">,
  attempt: Attempt,
  narrow: ((input: ReplyToolAuthorityInput) => ReplyToolAuthorityInput) | undefined,
  run: (prepared: Attempt & { toolAuthorityFingerprint?: string }) => Promise<T>,
): Promise<T> {
  const admitted = internal.admittedRunContext;
  const instance = admitted.operationalRunInstance;
  const assertAdmitted = resolveAdmittedRunActiveAssertion(admitted, attempt.abortSignal);
  const inherited = getGatewayToolCallerIdentity();
  const source = inherited?.operationalRunInstance === instance ? inherited : undefined;
  const { sessionId, sessionKey, sessionFile, agentId, runId } = attempt;
  const route = { provider: attempt.provider, model: attempt.modelId };
  // Maintenance borrows an operation for cancellation, not its injection snapshot.
  const operation = attempt.toolAuthorityFingerprint ? internal.replyOperation : undefined;
  const assertHostActive = attempt.hostCapabilities?.assertActive;
  const input: ReplyToolAuthorityInput = {
    originatingChannel: attempt.messageChannel,
    toolsAllow: attempt.toolsAllow,
    disableTools: attempt.disableTools,
    run: {
      ...attempt,
      model: attempt.modelId,
      runtimePolicySessionKey: attempt.sandboxSessionKey,
      traceAuthorized: false,
      spawnedBy: attempt.spawnedBy ?? undefined,
      senderId: attempt.senderId ?? undefined,
      senderName: attempt.senderName ?? undefined,
      senderUsername: attempt.senderUsername ?? undefined,
      senderE164: attempt.senderE164 ?? undefined,
      messageProvider: attempt.messageProvider ?? undefined,
      agentAccountId: attempt.agentAccountId ?? undefined,
      groupId: attempt.groupId ?? undefined,
      groupChannel: attempt.groupChannel ?? undefined,
      groupSpace: attempt.groupSpace ?? undefined,
    },
  };
  let live = true;
  // Preserve the complete admitted snapshot, but bind its hash and projection
  // only after hooks or native ownership have selected the actual model.
  const direct = operation ? undefined : prepareReplyToolAuthority(input, narrow);
  if (operation) {
    assertActive();
  }
  const fingerprint = operation ? operation.bindToolAuthorityRoute(route) : direct?.fingerprint();
  function assertActive() {
    if (
      !live ||
      !assertAdmitted ||
      admitted.operationalRunInstance !== instance ||
      instance.runId !== runId
    ) {
      throw new Error("embedded tool authority is no longer active");
    }
    assertAdmitted();
    assertHostActive?.();
    if (
      (source && (source.agentId !== agentId || source.sessionKey !== sessionKey)) ||
      (source?.workerTurnClaim &&
        (source.workerTurnClaim.sessionId !== sessionId ||
          source.workerTurnClaim.runId !== runId ||
          !source.receiptAuthority)) ||
      source?.receiptAuthority?.() === false ||
      (source?.gatewayContextResolver && !source.gatewayContextResolver())
    ) {
      throw new Error("embedded tool authority lost its source execution claim");
    }
  }
  const questionAuthority = sessionKey
    ? createAgentQuestionAnswerAuthority({
        sessionKey,
        fingerprint,
        project: (caller) =>
          operation
            ? operation.projectToolAuthorityFingerprint(caller)
            : direct?.project(caller, route),
        assertActive: () => {
          assertActive();
          if (
            operation &&
            (resolveActiveReplyOperationForSessionId(sessionId) !== operation ||
              operation.toolAuthorityRoute?.provider !== route.provider ||
              operation.toolAuthorityRoute.model !== route.model ||
              operation.toolAuthorityFingerprint !== fingerprint)
          ) {
            throw new Error("question creator reply authority is no longer active");
          }
        },
      })
    : undefined;
  if (attempt.hostCapabilities && questionAuthority) {
    registerAgentHarnessQuestionAnswerAuthority(attempt.hostCapabilities, questionAuthority);
  }
  const runPrepared = () =>
    withAgentQuestionAnswerAuthority(questionAuthority, () =>
      run({ ...attempt, toolAuthorityFingerprint: fingerprint }),
    );
  try {
    if (!agentId || !sessionKey) {
      return await runPrepared();
    }
    return await withGatewayToolCallerIdentity(
      {
        agentId,
        sessionKey,
        operationalRunInstance: instance,
        embeddedRunToolAuthorityBinding: (registration) => {
          assertActive();
          const { handle } = registration;
          if (
            registration.sessionId !== sessionId ||
            registration.sessionKey !== sessionKey ||
            registration.sessionFile !== sessionFile ||
            (registration.agentId !== undefined && registration.agentId !== agentId) ||
            handle.runId !== runId ||
            !fingerprint ||
            handle.toolAuthorityFingerprint !== fingerprint
          ) {
            throw new Error("embedded tool authority registration does not match its attempt");
          }
          const assertRegistered = () => {
            assertActive();
            if (handle.runId !== runId || handle.toolAuthorityFingerprint !== fingerprint) {
              throw new Error("embedded tool authority handle changed");
            }
          };
          const ownsOperation = () =>
            !operation ||
            (resolveActiveReplyOperationForSessionId(sessionId) === operation &&
              getAttachedBackend(operation) === handle &&
              operation.toolAuthorityRoute?.provider === route.provider &&
              operation.toolAuthorityRoute.model === route.model);
          assertRegistered();
          return {
            source: operation ? "reply" : "attempt",
            assertActive: assertRegistered,
            project: (overlay) => {
              assertRegistered();
              if (!ownsOperation()) {
                return undefined;
              }
              const projected = operation
                ? operation.projectToolAuthorityFingerprint(overlay)
                : direct?.project(overlay, route);
              assertRegistered();
              return ownsOperation() ? projected : undefined;
            },
          };
        },
      },
      runPrepared,
    );
  } finally {
    // Retained ALS callbacks do not extend the attempt's authority.
    live = false;
  }
}
