import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";

type CodexHookRequester = NonNullable<PluginHookToolContext["requester"]>;

/** Rebuilds the host-proven requester identity shared by native and bridged tool hooks. */
export function buildCodexHookRequester(
  params: Pick<
    EmbeddedRunAttemptParams,
    | "messageChannel"
    | "messageProvider"
    | "agentAccountId"
    | "senderId"
    | "senderIsOwner"
    | "memberRoleIds"
  >,
): CodexHookRequester | undefined {
  const channel = params.messageChannel ?? params.messageProvider;
  const requester: CodexHookRequester = {
    ...(channel ? { channel } : {}),
    ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
    ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
    ...(params.memberRoleIds?.length ? { roleIds: [...params.memberRoleIds] } : {}),
  };
  return Object.keys(requester).length > 0 ? requester : undefined;
}
