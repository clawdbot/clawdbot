export {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalForwardingFallbackSuppressor,
  nativeApprovalTargetsMatch,
  shouldSuppressLocalNativeExecApprovalPrompt,
} from "./approval-native-helpers.js";
export {
  resolveApprovalRequestSessionConversation,
  resolveApprovalRequestOriginTarget,
  resolveApprovalRequestSessionTarget,
  resolveExecApprovalSessionTarget,
  type ApprovalRequestSessionConversation,
  type ExecApprovalSessionTarget,
} from "../infra/exec-approval-session-target.js";
export { buildChannelApprovalNativeTargetKey } from "../infra/approval-native-target-key.js";
export {
  doesApprovalRequestMatchChannelAccount,
  resolveApprovalRequestAccountId,
  resolveApprovalRequestChannelAccountId,
} from "../infra/approval-request-account-binding.js";
