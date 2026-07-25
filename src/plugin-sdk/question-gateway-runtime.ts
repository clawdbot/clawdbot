/** Runtime SDK subpath for Gateway-backed ask_user question controls. */
import { registerQuestionChannelDelivery } from "../infra/question-channel-runtime.js";
// The pre-release named resolver exports were replaced wholesale by this
// runtime object before any tagged release shipped them; no compat aliases.
import { resolveQuestionOverGateway } from "../infra/question-gateway-resolver.js";
import {
  QUESTION_REACTION_EMOJIS,
  prepareQuestionReactionPayloadForDelivery,
  readAskUserQuestionId,
  readQuestionReactionBinding,
  resolveQuestionReactionIndex,
  resolveQuestionReactionOverGateway,
} from "../infra/question-reaction-runtime.js";

export const questionGatewayRuntime = {
  resolveOption: resolveQuestionOverGateway,
  reactionEmojis: QUESTION_REACTION_EMOJIS,
  prepareReactionPayloadForDelivery: prepareQuestionReactionPayloadForDelivery,
  readAskUserQuestionId,
  readReactionBinding: readQuestionReactionBinding,
  resolveReactionIndex: resolveQuestionReactionIndex,
  resolveReaction: resolveQuestionReactionOverGateway,
  registerChannelDelivery: registerQuestionChannelDelivery,
};
