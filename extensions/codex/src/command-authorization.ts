import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";

type CodexHostMutationAuthContext = Pick<
  PluginCommandContext,
  "gatewayClientScopes" | "senderIsOwner"
>;

export const CODEX_NATIVE_EXECUTION_AUTH_ERROR =
  "Only an owner or operator.admin can control Codex native execution.";
export const CODEX_FULL_PERMISSIONS_AUTH_ERROR =
  "Full Codex permissions require operator.admin. Choose Admin in the Control UI permission picker, or use an admin-authenticated CLI.";

export function hasCodexAdminScope(ctx: CodexHostMutationAuthContext): boolean {
  return ctx.gatewayClientScopes?.includes("operator.admin") === true;
}

export function canMutateCodexHost(ctx: CodexHostMutationAuthContext): boolean {
  return ctx.senderIsOwner === true || hasCodexAdminScope(ctx);
}
