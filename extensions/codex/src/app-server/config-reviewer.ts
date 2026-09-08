import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import type { CodexModelBackedReviewerContext } from "./config-contracts.js";
import { canUseCodexModelBackedApprovalsReviewerForModel as canUseModelBackedReviewer } from "./config-reviewer-policy.js";

export {
  assertCodexModelBackedReviewerEffectiveConfig,
  resolveCodexModelBackedReviewerPolicyContext,
} from "./config-reviewer-policy.js";

export function canUseCodexModelBackedApprovalsReviewerForModel(
  params: CodexModelBackedReviewerContext,
): boolean {
  return canUseModelBackedReviewer(params, resolveProviderIdForAuth);
}
