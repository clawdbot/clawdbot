/** Runtime SDK subpath for Gateway-backed ask_user question controls. */
import { readAskUserQuestionId } from "../auto-reply/reply-payload.js";
import { registerQuestionChannelDelivery } from "../infra/question-channel-runtime.js";
// The pre-release named resolver exports were replaced wholesale by this
// runtime object before any tagged release shipped them; no compat aliases.
import { resolveQuestionOverGateway } from "../infra/question-gateway-resolver.js";
export const questionGatewayRuntime = {
  resolveOption: resolveQuestionOverGateway,
  readAskUserQuestionId,
  registerChannelDelivery: registerQuestionChannelDelivery,
};
