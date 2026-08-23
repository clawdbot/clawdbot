import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
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
  }: Pick<GatewayRequestHandlerOptions, "params" | "respond" | "context" | "client">,
  onAdmissionOwned?: () => Promise<boolean>,
) {
  const normalizedRequest = normalizeChatSendRequest({ params, client });
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
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, preparedSession.error));
    return undefined;
  }
  const shouldAdmit = await runChatSendPreAdmission({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
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
