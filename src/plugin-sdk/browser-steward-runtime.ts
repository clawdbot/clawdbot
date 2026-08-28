import { withGatewayToolOperationApproval } from "../agents/tools/gateway-caller-context.js";
import type { GatewayToolOperationApproval } from "../gateway/agent-runtime-identity-token.js";
import { withPluginRuntimeGatewayRequestAuthority } from "../plugins/runtime/gateway-request-scope.js";

/** Private operation proof used only by the bundled Browser plugin. */
export type BrowserStewardGatewayApprovalClaim = Omit<GatewayToolOperationApproval, "owner">;

/** Carries one exact Browser operation into the signed local agent identity. */
export function withBrowserStewardGatewayApproval<T>(
  claim: BrowserStewardGatewayApprovalClaim,
  run: () => Promise<T> | T,
): Promise<T> {
  return withGatewayToolOperationApproval({ owner: "browser", ...claim }, run);
}

/** Keeps deferred Browser-owned Gateway work bound to the provider lifecycle. */
export async function withBrowserStewardRuntimeAuthority<T>(
  authority: () => boolean,
  run: () => Promise<T> | T,
): Promise<T> {
  return await withPluginRuntimeGatewayRequestAuthority(authority, run);
}
