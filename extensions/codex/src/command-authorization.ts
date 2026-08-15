import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";

type CodexHostMutationAuthContext = Pick<
  PluginCommandContext,
  "gatewayClientScopes" | "senderIsOwner"
>;

export const CODEX_NATIVE_EXECUTION_AUTH_ERROR =
  "Only an owner or operator.admin can control Codex native execution.";

export function canMutateCodexHost(ctx: CodexHostMutationAuthContext): boolean {
  return ctx.senderIsOwner === true || ctx.gatewayClientScopes?.includes("operator.admin") === true;
}
