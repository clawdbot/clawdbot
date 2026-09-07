import { isDeepStrictEqual } from "node:util";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-profile.js";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import {
  resolveCodexSessionBinding,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerThreadBinding,
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
  "assertCurrent" | "authProfileId" | "sessionId" | "sessionKey" | "startOptions" | "storePath"
> & { agentId: string; agentDir: string };

export type PreparedCodexCommandAuthority = {
  target: CodexConversationControlTarget | undefined;
  binding: CodexAppServerThreadBinding | undefined;
  currentSessionBinding: CodexAppServerThreadBinding | undefined;
  sessionId: string | undefined;
  sessionKey: string | undefined;
  storePath: string | undefined;
  assertHostCurrent: () => void;
  assertCurrent: () => void;
};

export async function resolvePreparedCodexCommandAuthority(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<PreparedCodexCommandAuthority> {
  const target = await resolveControlTarget(ctx);
  const fallback = resolveCodexConversationControlScope(ctx);
  const sessionId = ctx.sessionId;
  const sessionKey = ctx.sessionKey;
  const sessionAgentId = ctx.sessionTarget?.agentId ?? fallback.agentId;
  const storePath =
    ctx.sessionTarget?.storePath ??
    (sessionKey
      ? resolveStorePath(ctx.config.session?.store, { agentId: sessionAgentId })
      : undefined);
  const sessionIdentity = sessionId
    ? sessionBindingIdentity({
        sessionId,
        sessionKey,
        agentId: sessionAgentId,
        config: ctx.config,
      })
    : undefined;
  const currentSession = sessionIdentity
    ? await resolveCodexSessionBinding({
        reclaimStale: true,
        bindingStore: deps.bindingStore,
        identity: sessionIdentity,
        config: ctx.config,
        storePath,
      })
    : undefined;
  const assertHostCurrent = currentSession?.assertCurrent ?? (() => {});
  const resolvedTarget =
    target && (!sessionIdentity || !isDeepStrictEqual(target.identity, sessionIdentity))
      ? await resolveCodexSessionBinding({
          bindingStore: deps.bindingStore,
          identity: target.identity,
          config: ctx.config,
          storePath,
          assertCurrent: assertHostCurrent,
        })
      : currentSession;
  const binding = resolvedTarget?.binding;
  const assertCurrent = () => {
    assertHostCurrent();
    if (target && !isDeepStrictEqual(deps.bindingStore.read(target.identity), binding)) {
      throw new Error("Codex command binding changed before dispatch");
    }
    assertHostCurrent();
  };
  assertCurrent();
  return {
    target,
    binding,
    currentSessionBinding: currentSession?.binding,
    sessionId,
    sessionKey,
    storePath,
    assertHostCurrent,
    assertCurrent,
  };
}

export async function resolveCommandAppServerScope(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
): Promise<CommandAppServerScope> {
  const authority = await resolvePreparedCodexCommandAuthority(deps, ctx);
  const { target, binding } = authority;
  const fallback = resolveCodexConversationControlScope(ctx);
  const agentDir = target?.agentDir ?? fallback.agentDir;
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
    ...(authority.sessionKey ? { sessionKey: authority.sessionKey } : {}),
    ...(authority.sessionId ? { sessionId: authority.sessionId } : {}),
    ...(authority.storePath ? { storePath: authority.storePath } : {}),
    assertCurrent: authority.assertCurrent,
  };
}

export function conversationBindingIdentity(
  bindingId: string,
): Extract<CodexAppServerBindingIdentity, { kind: "conversation" }> {
  return { kind: "conversation", bindingId };
}

export function resolveCodexConversationControlScope(ctx: PluginCommandContext): {
  agentId: string;
  agentDir: string;
} {
  const { sessionAgentId } = resolveSessionAgentIdsStrict({
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    config: ctx.config,
  });
  return {
    agentId: sessionAgentId,
    agentDir: resolveAgentDir(ctx.config, sessionAgentId),
  };
}
