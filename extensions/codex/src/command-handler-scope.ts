import { resolveAgentDir, resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
} from "./app-server/session-binding.js";
import type { CodexCommandDeps } from "./command-handler-deps.js";
import type { CodexControlRequestOptions } from "./command-rpc.js";
import { readCodexConversationBindingData } from "./conversation-binding-data.js";

type CodexConversationControlTarget = {
  identity: CodexAppServerBindingIdentity;
  agentId: string;
  agentDir: string;
  requestedAuthProfileId?: string;
};

export async function resolveControlTarget(
  ctx: PluginCommandContext,
): Promise<CodexConversationControlTarget | undefined> {
  const binding = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(binding);
  const scope = resolveCodexConversationControlScope(ctx);
  if (data?.kind === "codex-app-server-session") {
    return {
      identity: conversationBindingIdentity(data.bindingId),
      agentId: data.agentId ?? scope.agentId,
      agentDir: data.agentDir ?? scope.agentDir,
      requestedAuthProfileId: data.start?.authProfileId,
    };
  }
  return ctx.sessionId
    ? {
        identity: sessionBindingIdentity({
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          agentId: scope.agentId,
          config: ctx.config,
        }),
        agentId: scope.agentId,
        agentDir: scope.agentDir,
      }
    : undefined;
}

type CommandAppServerScope = Pick<
  CodexControlRequestOptions,
  "authProfileId" | "sessionId" | "sessionKey" | "startOptions"
> & { agentId: string; agentDir: string };

export async function resolveCommandAppServerScope(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
): Promise<CommandAppServerScope> {
  const target = await resolveControlTarget(ctx);
  const fallback = resolveCodexConversationControlScope(ctx);
  const agentDir = target?.agentDir ?? fallback.agentDir;
  const binding = target ? await deps.bindingStore.read(target.identity) : undefined;
  const authProfileId =
    binding?.connectionScope === "supervision"
      ? undefined
      : resolveCodexAppServerAuthProfileIdForAgent({
          authProfileId: binding?.authProfileId ?? target?.requestedAuthProfileId,
          agentDir,
          config: ctx.config,
        });
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId,
    pluginConfig,
  });
  return {
    agentId: target?.agentId ?? fallback.agentId,
    agentDir,
    ...(connection.clientAuthProfileId !== undefined
      ? { authProfileId: connection.clientAuthProfileId }
      : {}),
    ...(connection.usesSupervisionConnection ? { startOptions: connection.appServer.start } : {}),
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  };
}

export function conversationBindingIdentity(bindingId: string): CodexAppServerBindingIdentity {
  return { kind: "conversation", bindingId };
}

export function resolveCodexConversationControlScope(ctx: PluginCommandContext): {
  agentId: string;
  agentDir: string;
} {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    config: ctx.config,
  });
  return {
    agentId: sessionAgentId,
    agentDir: resolveAgentDir(ctx.config, sessionAgentId),
  };
}
