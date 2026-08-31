/** Exact-run decision receipts for message-tool boundaries without a durable owner. */
import { recordMessageActionDecision } from "../../audit/message-action-decision.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

type Decision = Omit<
  Parameters<typeof recordMessageActionDecision>[0],
  "token" | "actionId" | "action" | "channel"
>;

export function createMessageToolDecisionRecorder(params: {
  actionId: string;
  action: string;
  channel?: string;
}) {
  const token = getGatewayToolCallerIdentity()?.executionIdentityToken;
  const { channel: sourceChannel, ...decisionIdentity } = params;
  const recordWithChannel = (decision: Decision, channel: string | undefined) =>
    recordMessageActionDecision({
      token,
      ...decisionIdentity,
      ...(channel ? { channel } : {}),
      ...decision,
    });
  const record = (decision: Decision) => recordWithChannel(decision, sourceChannel);
  const recordTypedDenial = (
    error: unknown,
    channel = sourceChannel,
    receiptDiscriminator?: string,
  ): void => {
    if (!(error instanceof MessageActionDeniedError)) {
      return;
    }
    recordWithChannel(
      {
        outcome: "denied",
        reasonCode: error.reasonCode,
        coverageState: "enforced",
        policyRefs: [error.policyRef],
        summary: "Message action was denied before platform delivery.",
        remediation: [
          {
            code: "correct_message_action_request",
            text: "Correct the target or policy violation described by the tool error, then retry.",
          },
        ],
        receiptDiscriminator,
      },
      channel,
    );
  };
  return {
    executionIdentityToken: token,
    recordTypedDenial,
    runBoundary<T>(operation: () => T): T {
      try {
        return operation();
      } catch (error) {
        recordTypedDenial(error);
        throw error;
      }
    },
    recordTurnCapabilityInactive() {
      record({
        outcome: "denied",
        reasonCode: "message_turn_capability_inactive",
        coverageState: "enforced",
        policyRefs: ["message-turn-capability:active"],
        summary: "Message action was denied because its turn capability was no longer active.",
        remediation: [
          {
            code: "start_new_message_turn",
            text: "Start a new admitted turn before retrying this message action.",
          },
        ],
      });
    },
    recordVisibleTextSuppressed(reasonCode: string) {
      record({
        outcome: "not-applicable",
        reasonCode: `message_suppressed_${reasonCode}`,
        coverageState: "attribution-only",
        summary: "Outbound text was intentionally suppressed before delivery.",
        remediation: [
          {
            code: "provide_new_message_content",
            text: "Provide message content that is not copied runtime or inbound metadata.",
          },
        ],
      });
    },
    recordExplicitTargetMissing() {
      record({
        outcome: "denied",
        reasonCode: "message_target_missing",
        coverageState: "enforced",
        policyRefs: ["message-target:explicit"],
        summary: "Message action was denied because this run requires an explicit target.",
        remediation: [
          {
            code: "provide_explicit_message_target",
            text: "Provide target or targets, and channel when needed, then retry.",
          },
        ],
      });
    },
    recordPollVoteEchoSuppressed() {
      record({
        outcome: "not-applicable",
        reasonCode: "message_suppressed_poll_vote_echo",
        coverageState: "attribution-only",
        summary: "Outbound text was intentionally suppressed because it repeated a poll vote.",
        remediation: [
          {
            code: "provide_non_duplicate_message",
            text: "Only send follow-up text when it adds information beyond the recorded poll vote.",
          },
        ],
      });
    },
    recordActionResult(result: MessageActionResult, trustedChannel?: string) {
      if (
        result.kind !== "action" &&
        result.kind !== "poll" &&
        (result.kind !== "send" || (result.handledBy !== "internal-source" && !result.dryRun))
      ) {
        return;
      }
      recordWithChannel(
        {
          outcome: result.dryRun ? "not-applicable" : "allowed",
          reasonCode: result.dryRun ? "message_action_dry_run" : "message_action_completed",
          coverageState: "attribution-only",
          summary: result.dryRun
            ? "Message action was prepared without platform delivery."
            : "Portable message action completed through its action owner.",
          remediation: result.dryRun
            ? [
                {
                  code: "run_message_action",
                  text: "Remove dry-run mode to perform the message action.",
                },
              ]
            : [],
        },
        trustedChannel,
      );
    },
  };
}
