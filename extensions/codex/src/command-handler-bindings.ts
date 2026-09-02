import crypto from "node:crypto";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { closeCodexStartupClientBestEffort } from "./app-server/attempt-client-cleanup.js";
import {
  consumeCodexAppServerLiveThread,
  hasCodexAppServerLiveThread,
  type CodexAppServerLiveThreadOwnership,
} from "./app-server/client-runtime.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import { isCodexFastServiceTier } from "./app-server/config.js";
import {
  assertCodexThreadAcceptsDirectInput,
  assertCodexThreadResumeResponse,
} from "./app-server/protocol-validators.js";
import type { CodexThread } from "./app-server/protocol.js";
import {
  assertCodexBindingMayBeReplaced,
  createCodexSessionGenerationSupersededError,
  normalizeCodexAppServerBindingModelProvider,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
} from "./app-server/session-binding.js";
import {
  isSameCodexAppServerThreadOwner,
  releaseCodexAppServerBindingSubscription,
  retainCodexAppServerBindingSubscription,
  retireCodexConversationThreadBinding,
  rollbackCodexAppServerBindingSubscription,
  withCodexConversationThreadActivity,
  withExclusiveCodexAppServerThread,
} from "./app-server/thread-ownership.js";
import { formatCodexDisplayText, formatThreads } from "./command-formatters.js";
import {
  parseBindArgs,
  parseCodexCliSessionsArgs,
  type ParsedResumeArgs,
  parseResumeArgs,
} from "./command-handler-args.js";
import { CODEX_CONTROL_METHODS, type CodexCommandDeps } from "./command-handler-deps.js";
import {
  conversationBindingIdentity,
  resolveCodexConversationControlScope,
  resolveCommandAppServerScope,
} from "./command-handler-scope.js";
import {
  createCodexCliNodeConversationBindingData,
  createCodexConversationBindingData,
  readCodexConversationBindingData,
} from "./conversation-binding-data.js";
import { formatPermissionsMode } from "./conversation-control.js";
import { isIncognitoSessionKey } from "./incognito-session.js";
import { formatCodexCliSessions } from "./node-cli-sessions.js";

export function isCurrentSessionModelSelectionLocked(ctx: PluginCommandContext): boolean {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  // SessionEntry is the durable authority even when a native binding is absent or stale.
  // Never infer this lock from binding model metadata such as preserveNativeModel.
  const { agentId } = resolveCodexConversationControlScope(ctx);
  const storePath = resolveStorePath(ctx.config.session?.store, { agentId });
  return isModelSelectionLocked(
    getSessionEntry({
      storePath,
      sessionKey,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    }),
  );
}

export async function bindConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<PluginCommandResult> {
  const parsed = parseBindArgs(args);
  if (parsed.help) {
    return {
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    };
  }
  if (isCurrentSessionModelSelectionLocked(ctx)) {
    return { text: MODEL_SELECTION_LOCKED_MESSAGE };
  }
  const scope = resolveCodexConversationControlScope(ctx);
  const workspaceDir = parsed.cwd ?? deps.resolveCodexDefaultWorkspaceDir(pluginConfig);
  const currentConversation = await ctx.getCurrentConversationBinding();
  const currentConversationData = readCodexConversationBindingData(currentConversation);
  const bindingId =
    currentConversationData?.kind === "codex-app-server-session"
      ? currentConversationData.bindingId
      : currentConversation
        ? `conversation-${currentConversation.bindingId}`
        : undefined;
  const sessionOwner = ctx.sessionId
    ? sessionBindingIdentity({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: scope.agentId,
        config: ctx.config,
      })
    : undefined;
  const currentOwner =
    currentConversationData?.kind === "codex-app-server-session"
      ? conversationBindingIdentity(currentConversationData.bindingId)
      : sessionOwner;
  const existingBinding = currentOwner ? await deps.bindingStore.read(currentOwner) : undefined;
  assertCodexBindingMayBeReplaced(existingBinding, "binding this conversation to another thread");
  const sessionSource =
    sessionOwner && existingBinding
      ? {
          agentId: sessionOwner.agentId,
          sessionId: sessionOwner.sessionId,
          threadId: existingBinding.threadId,
          ...(sessionOwner.sessionKey ? { sessionKey: sessionOwner.sessionKey } : {}),
        }
      : undefined;
  const authProfileId = existingBinding?.authProfileId;
  // The intent generation lets inbound routing materialize one canonical
  // thread after approval without any command/message startup race.
  const data = createCodexConversationBindingData({
    bindingId,
    workspaceDir,
    agentId: scope.agentId,
    agentDir: scope.agentDir,
    source:
      currentConversationData?.kind === "codex-app-server-session"
        ? currentConversationData.source
        : sessionSource,
    start: {
      id: crypto.randomUUID(),
      threadId: parsed.threadId,
      model: parsed.model,
      modelProvider: parsed.provider,
      authProfileId,
    },
  });
  const threadLabel = parsed.threadId ?? "a new thread";
  const request = await ctx.requestConversationBinding({
    summary: `Codex app-server thread ${formatCodexDisplayText(threadLabel)} in ${formatCodexDisplayText(workspaceDir)}`,
    detachHint: "/codex detach",
    data,
  });
  if (request.status === "pending") {
    return request.reply;
  }
  if (request.status === "error") {
    return { text: formatCodexDisplayText(request.message) };
  }
  return {
    text: `Bound this conversation to ${formatCodexDisplayText(
      threadLabel,
    )} in ${formatCodexDisplayText(workspaceDir)}. The next message will initialize it.`,
  };
}

export async function detachConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  if (isCurrentSessionModelSelectionLocked(ctx)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  const identity =
    data?.kind === "codex-app-server-session"
      ? conversationBindingIdentity(data.bindingId)
      : undefined;
  const sourceSessionKey =
    data?.kind === "codex-app-server-session" ? data.source?.sessionKey : undefined;
  let expectedThreadId: string | undefined;
  let expectedStartId: string | undefined;
  if (data?.kind === "codex-app-server-session") {
    const binding = await deps.bindingStore.read(identity!);
    assertCodexBindingMayBeReplaced(binding, "detaching its conversation binding");
    if (deps.readCodexConversationActiveTurn(identity!)) {
      return "This Codex conversation has an active run; use /codex stop before detaching it.";
    }
    expectedThreadId = binding?.threadId;
    expectedStartId = binding?.conversationStartId;
  }
  const detachPublicConversation = async () => {
    const detached = await ctx.detachConversationBinding();
    return detached.removed
      ? "Detached this conversation from Codex."
      : "No Codex conversation binding was attached.";
  };
  if (identity && expectedThreadId) {
    return await withCodexConversationThreadActivity(identity.bindingId, async () => {
      let detachedPublicConversation: string | undefined;
      const retired = await retireCodexConversationThreadBinding({
        bindingStore: deps.bindingStore,
        identity,
        expectedThreadId,
        ...(expectedStartId ? { expectedStartId } : {}),
        // The source session owns ephemeral tracking; destination channel
        // session keys do not describe how this subscription was created.
        ...(isIncognitoSessionKey(sourceSessionKey) ? { allowUntracked: true } : {}),
        afterClear: async () => {
          // The owner restores the exact native row if public detach fails;
          // an attached conversation then resumes its original thread.
          detachedPublicConversation = await detachPublicConversation();
        },
      });
      if (!retired) {
        return "This Codex conversation binding changed while detaching; try again.";
      }
      return detachedPublicConversation!;
    });
  }
  return await detachPublicConversation();
}

export async function describeConversationBinding(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  if (!current || !data) {
    return "No Codex conversation binding is attached.";
  }
  if (data.kind === "codex-cli-node-session") {
    return [
      "Codex conversation binding:",
      "- Mode: Codex CLI node session",
      `- Node: ${formatCodexDisplayText(data.nodeId)}`,
      `- Session: ${formatCodexDisplayText(data.sessionId)}`,
      `- Workspace: ${formatCodexDisplayText(data.cwd ?? "unknown")}`,
      "- Active run: not tracked",
    ].join("\n");
  }
  const identity = conversationBindingIdentity(data.bindingId);
  const threadBinding = await deps.bindingStore.read(identity);
  const active = deps.readCodexConversationActiveTurn(identity);
  const sessionKey = ctx.sessionKey?.trim();
  const { agentId } = resolveCodexConversationControlScope(ctx);
  const sessionEntry = sessionKey
    ? getSessionEntry({
        agentId,
        storePath: resolveStorePath(ctx.config.session?.store, { agentId }),
        sessionKey,
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
      })
    : undefined;
  const permissionMode =
    !ctx.sessionId || sessionEntry?.sessionId === ctx.sessionId
      ? sessionEntry?.permissionMode
      : undefined;
  return [
    "Codex conversation binding:",
    `- Thread: ${formatCodexDisplayText(threadBinding?.threadId ?? "unknown")}`,
    `- Workspace: ${formatCodexDisplayText(data.workspaceDir)}`,
    `- Model: ${formatCodexDisplayText(threadBinding?.model ?? "default")}`,
    `- Fast: ${isCodexFastServiceTier(threadBinding?.serviceTier) ? "on" : "off"}`,
    `- Permissions: ${formatPermissionsMode(permissionMode)}`,
    `- Active run: ${formatCodexDisplayText(active ? active.turnId : "none")}`,
    `- Binding: ${formatCodexDisplayText(data.bindingId)}`,
  ].join("\n");
}

export async function buildThreads(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  filter: string,
): Promise<string> {
  const scope = await resolveCommandAppServerScope(deps, ctx, pluginConfig);
  const response = await deps.codexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.listThreads,
    {
      limit: 10,
      ...(filter.trim() ? { searchTerm: filter.trim() } : {}),
    },
    { config: ctx.config, ...scope },
  );
  return formatThreads(response);
}

export async function buildCodexCliSessions(
  deps: CodexCommandDeps,
  args: string[],
): Promise<string> {
  const parsed = parseCodexCliSessionsArgs(args);
  if (parsed.help || !parsed.host) {
    return "Usage: /codex sessions --host <node> [filter] [--limit <n>]";
  }
  return formatCodexCliSessions(
    await deps.listCodexCliSessionsOnNode({
      requestedNode: parsed.host,
      filter: parsed.filter,
      limit: parsed.limit,
    }),
  );
}

export async function resumeThread(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const parsed = parseResumeArgs(args);
  const normalizedThreadId = parsed.threadId?.trim();
  if (parsed.help) {
    return args.includes("--help") || args.includes("-h") || parsed.host
      ? "Usage: /codex resume <thread-id>\nUsage: /codex resume <session-id> --host <node> --bind here"
      : "Usage: /codex resume <thread-id>";
  }
  if (parsed.host) {
    return await bindCodexCliNodeSession(deps, ctx, parsed);
  }
  if (!normalizedThreadId || args.length !== 1) {
    return "Usage: /codex resume <thread-id>";
  }
  if (isCurrentSessionModelSelectionLocked(ctx)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  if (!ctx.sessionId) {
    return "Cannot attach a Codex thread because this command did not include an OpenClaw session id.";
  }
  const scope = resolveCodexConversationControlScope(ctx);
  const identity = sessionBindingIdentity({
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: scope.agentId,
    config: ctx.config,
  });
  return await withExclusiveCodexAppServerThread({
    bindingStore: deps.bindingStore,
    identity,
    threadId: normalizedThreadId,
    run: async () =>
      await deps.bindingStore.withLease(identity, async () => {
        const reclaimed = await reclaimCurrentCodexSessionGeneration({
          bindingStore: deps.bindingStore,
          identity,
          config: ctx.config,
        });
        if (!reclaimed) {
          throw createCodexSessionGenerationSupersededError(identity.sessionId);
        }
        const currentBinding = await deps.bindingStore.read(identity);
        assertCodexBindingMayBeReplaced(currentBinding, "attaching a different resumed thread");
        let pendingResumeConfiguration = false;
        const commitResumedThread = async (
          value: unknown,
          client: CodexAppServerClient,
          { authProfileId, assertCurrent }: { authProfileId?: string; assertCurrent: () => void },
        ) => {
          const response = assertCodexThreadResumeResponse(value);
          const effectiveThreadId = response.thread.id;
          if (effectiveThreadId !== normalizedThreadId) {
            throw new Error(
              `Codex thread/resume returned ${effectiveThreadId} for ${normalizedThreadId}`,
            );
          }
          const resumedCwd = response.thread.cwd;
          if (typeof resumedCwd !== "string") {
            throw new Error(`Codex thread/resume returned no cwd for ${normalizedThreadId}`);
          }
          const modelProvider = normalizeCodexAppServerBindingModelProvider({
            authProfileId,
            modelProvider: response.modelProvider ?? undefined,
            agentDir: scope.agentDir,
            config: ctx.config,
          });
          const clientId = client.getInstanceId();
          let retained = false;
          let sameOwner = false;
          let knownOwnership: CodexAppServerLiveThreadOwnership | undefined;
          try {
            const bindingBeforeCommit = await deps.bindingStore.read(identity);
            assertCodexBindingMayBeReplaced(
              bindingBeforeCommit,
              "committing a different resumed thread",
            );
            sameOwner = isSameCodexAppServerThreadOwner(bindingBeforeCommit, {
              threadId: effectiveThreadId,
              clientId,
            });
            const sameThreadBinding =
              bindingBeforeCommit?.threadId === effectiveThreadId ? bindingBeforeCommit : undefined;
            pendingResumeConfiguration =
              sameThreadBinding?.preserveNativeModel !== true &&
              (!sameThreadBinding?.dynamicToolsFingerprint ||
                !sameThreadBinding.webSearchThreadConfigFingerprint ||
                sameThreadBinding.pendingResumeConfiguration === true);
            assertCurrent();
            assertCodexThreadAcceptsDirectInput(response.thread);
            knownOwnership = sameOwner
              ? await consumeCodexAppServerLiveThread(client, effectiveThreadId)
              : undefined;
            assertCurrent();
            retained = await retainCodexAppServerBindingSubscription(
              client,
              effectiveThreadId,
              knownOwnership,
            );
            assertCurrent();
            if (!retained) {
              throw new Error("Codex resumed thread lost its native subscription owner.");
            }
            if (bindingBeforeCommit && !sameOwner) {
              // The old row must remain authoritative until its subscription
              // is gone; otherwise another session can claim and lose it.
              await releaseCodexAppServerBindingSubscription(bindingBeforeCommit);
            }
            assertCurrent();
            const committed = await deps.bindingStore.mutate(
              identity,
              {
                kind: "set",
                binding: {
                  ...sameThreadBinding,
                  threadId: effectiveThreadId,
                  clientId,
                  cwd: resumedCwd,
                  rolloutPath: response.thread.path ?? sameThreadBinding?.rolloutPath,
                  pendingResumeConfiguration: pendingResumeConfiguration ? true : undefined,
                  authProfileId,
                  model: response.model,
                  modelProvider,
                  historyCoveredThrough: new Date().toISOString(),
                },
              },
              assertCurrent,
            );
            if (!committed) {
              throw new Error("Codex thread binding changed while attaching the resumed thread.");
            }
          } catch (error) {
            if (sameOwner && knownOwnership && !retained) {
              // Deadline expiry after consuming an idle owner must restore its exact claim.
              if (
                !(await retainCodexAppServerBindingSubscription(
                  client,
                  effectiveThreadId,
                  knownOwnership,
                ))
              ) {
                await closeCodexStartupClientBestEffort(client);
              }
            } else if (
              (retained && !sameOwner) ||
              !hasCodexAppServerLiveThread(client, effectiveThreadId)
            ) {
              await rollbackCodexAppServerBindingSubscription(client, effectiveThreadId, retained);
            }
            throw error;
          }
        };
        await deps.codexControlRequest(
          pluginConfig,
          CODEX_CONTROL_METHODS.resumeThread,
          {
            threadId: normalizedThreadId,
            excludeTurns: true,
          },
          {
            config: ctx.config,
            agentId: scope.agentId,
            agentDir: scope.agentDir,
            authProfileId: currentBinding?.authProfileId,
            sessionKey: ctx.sessionKey,
            sessionId: ctx.sessionId,
            beforeRequest: async (request) => {
              const { thread } = await request<{ thread: CodexThread }>({
                method: "thread/read",
                requestParams: { threadId: normalizedThreadId, includeTurns: false },
              });
              assertCodexThreadAcceptsDirectInput(thread);
            },
            onResponse: commitResumedThread,
          },
        );
        return `Attached this OpenClaw session to Codex thread ${formatCodexDisplayText(
          normalizedThreadId,
        )}.${pendingResumeConfiguration ? " The next turn will validate its tools and apply this session's configuration before continuing." : ""}`;
      }),
  });
}

async function bindCodexCliNodeSession(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  parsed: ParsedResumeArgs,
): Promise<string> {
  if (!parsed.threadId || !parsed.host || parsed.bindHere !== true) {
    return "Usage: /codex resume <session-id> --host <node> --bind here";
  }
  if (isCurrentSessionModelSelectionLocked(ctx)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  if (ctx.sessionId) {
    const scope = resolveCodexConversationControlScope(ctx);
    const binding = await deps.bindingStore.read(
      sessionBindingIdentity({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        agentId: scope.agentId,
        config: ctx.config,
      }),
    );
    assertCodexBindingMayBeReplaced(binding, "binding a Codex CLI node session");
  }
  const resolved = await deps.resolveCodexCliSessionForBindingOnNode({
    requestedNode: parsed.host,
    sessionId: parsed.threadId,
  });
  if (!resolved.session) {
    return `No Codex CLI session ${formatCodexDisplayText(parsed.threadId)} was found on ${formatCodexDisplayText(parsed.host)}.`;
  }
  const nodeId = resolved.node.nodeId;
  if (!nodeId) {
    return "Cannot bind Codex CLI session because the selected node did not include a node id.";
  }
  const scope = resolveCodexConversationControlScope(ctx);
  const data = createCodexCliNodeConversationBindingData({
    nodeId,
    sessionId: parsed.threadId,
    agentId: scope.agentId,
    cwd: resolved.session?.cwd,
  });
  const summary = `Codex CLI session ${formatCodexDisplayText(parsed.threadId)} on ${formatCodexDisplayText(nodeId)}`;
  const request = await ctx.requestConversationBinding({
    summary,
    detachHint: "/codex detach",
    data,
  });
  if (request.status === "bound") {
    return `Bound this conversation to Codex CLI session ${formatCodexDisplayText(
      parsed.threadId,
    )} on ${formatCodexDisplayText(nodeId)}.`;
  }
  if (request.status === "pending") {
    return request.reply.text ?? "Codex CLI session binding is pending approval.";
  }
  return formatCodexDisplayText(request.message);
}
