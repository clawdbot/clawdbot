// Slack plugin module implements approval auth behavior.
import {
  createChannelApprovalAuth,
  resolveApprovalApprovers,
} from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveSlackAccount, resolveSlackAccountAllowFrom } from "./accounts.js";
import { normalizeSlackApproverTarget } from "./exec-approvals.js";
import {
  normalizeAllowListLower,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowListForTeam,
} from "./monitor/allow-list.js";
import { parseSlackTarget } from "./target-parsing.js";

type SlackApprovalContext = Parameters<typeof resolveSlackAccount>[0];

function resolveSlackApprovalInputs(params: SlackApprovalContext) {
  const account = resolveSlackAccount(params).config;
  return {
    allowFrom: resolveSlackAccountAllowFrom(params),
    defaultTo: account.defaultTo,
  };
}

function slackApprovalTargetMatches(senderId: string, approvers: readonly string[]): boolean {
  const sender = parseSlackTarget(senderId, { defaultKind: "user" });
  return (
    sender?.kind === "user" &&
    resolveSlackAllowListMatch({
      allowList: normalizeAllowListLower([...approvers]),
      teamId: sender.teamId,
      id: sender.id,
    }).allowed
  );
}

const slackApproval = createChannelApprovalAuth({
  channelLabel: "Slack",
  resolveInputs: resolveSlackApprovalInputs,
  normalizeApprover: normalizeSlackApproverTarget,
  normalizeDefaultTo: normalizeSlackApproverTarget,
  normalizeSenderId: normalizeSlackApproverTarget,
  isWildcardAuthorized: ({ purpose, senderId, inputs, approvers }) =>
    Boolean(
      senderId &&
      (slackApprovalTargetMatches(senderId, approvers) ||
        (purpose === "sender" &&
          approvers.length === 0 &&
          inputs.allowFrom?.some((entry) => String(entry).trim() === "*"))),
    ),
});

export const getSlackApprovalApprovers = slackApproval.resolveApprovers;
export const isSlackApprovalAuthorizedSender = slackApproval.isAuthorizedSender;

export function getSlackApprovalApproversForTeam(
  params: SlackApprovalContext & { teamId: string | undefined },
): string[] {
  // Potential routing retains qualified selectors, but concrete delivery must
  // bind them to the validated request workspace before it creates any DM.
  return resolveApprovalApprovers({
    allowFrom: resolveSlackUserAllowListForTeam({
      allowList: getSlackApprovalApprovers(params),
      teamId: params.teamId,
    }),
    normalizeApprover: normalizeSlackApproverTarget,
  });
}
