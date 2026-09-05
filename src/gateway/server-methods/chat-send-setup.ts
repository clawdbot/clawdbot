import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import { admitChatSend } from "./chat-send-admission.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Normalize, prepare, and exclusively admit one new chat.send request. */
export async function prepareAndAdmitChatSend(
  {
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }: Pick<
    GatewayRequestHandlerOptions,
    "params" | "respond" | "context" | "client" | "sessionMutationAuthorization"
  >,
  onAdmissionOwned?: () => Promise<boolean>,
  options?: {
    trustedSystemInput?: boolean;
    goalResume?: SessionGoalOperation & { action: "resume" };
  },
) {
  const normalizedRequest = normalizeChatSendRequest({
    params,
    client,
    ...(options?.trustedSystemInput ? { trustedSystemInput: true } : {}),
    ...(options?.goalResume ? { goalResume: options.goalResume } : {}),
  });
  if (!normalizedRequest.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        normalizedRequest.error,
        normalizedRequest.reason ? { details: { reason: normalizedRequest.reason } } : undefined,
      ),
    );
    return undefined;
  }
  const preparedSession = prepareChatSendSession({
    request: normalizedRequest.value,
    context,
    client,
  });
  if (!preparedSession.ok) {
    respond(
      false,
      undefined,
      typeof preparedSession.error === "string"
        ? errorShape(ErrorCodes.INVALID_REQUEST, preparedSession.error)
        : preparedSession.error,
    );
    return undefined;
  }
  if (normalizedRequest.value.mentions) {
    const mentions = context.mentionInbox?.validateRecipients(
      client,
      preparedSession.value.entry
        ? { sessionKey: preparedSession.value.sessionKey, agentId: preparedSession.value.agentId }
        : { agentId: preparedSession.value.agentId },
      normalizedRequest.value.mentions.map((mention) => mention.profileId),
    );
    if (!mentions?.ok) {
      respond(
        false,
        undefined,
        mentions?.error ??
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Human mentions are unavailable; reconnect and retry.",
          ),
      );
      return undefined;
    }
  }
  const shouldAdmit = await runChatSendPreAdmission({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
    assertCurrent: sessionMutationAuthorization?.assertCurrent,
  });
  if (!shouldAdmit) {
    return undefined;
  }
  const admitted = await admitChatSend({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
    onAdmissionOwned,
  });
  if (!admitted.ok) {
    return undefined;
  }
  return { normalizedRequest, preparedSession, admitted };
}
