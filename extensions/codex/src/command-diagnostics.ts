import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import { isJsonObject } from "./app-server/protocol.js";
import {
  bindingStoreKey,
  sessionBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import type { CodexDiagnosticsTarget } from "./command-diagnostics-state.js";
import {
  buildDiagnosticsTags,
  codexDiagnosticsTargetsMatch,
  createCodexDiagnosticsConfirmation,
  deletePendingCodexDiagnosticsConfirmation,
  escapeCodexChatText,
  formatCodexDiagnosticsTargetLines,
  formatCodexDiagnosticsUploadResult,
  formatCodexTextForDisplay,
  formatDiagnosticsUsage,
  normalizeDiagnosticsReason,
  parseDiagnosticsArgs,
  readCodexDiagnosticsConfirmationScope,
  readCodexDiagnosticsCooldownScope,
  readCodexDiagnosticsScopeMismatch,
  readCodexDiagnosticsTargetsCooldownMessage,
  readPendingCodexDiagnosticsConfirmation,
  recordCodexDiagnosticsUpload,
} from "./command-diagnostics-support.js";
import { readString } from "./command-formatters.js";
import { CODEX_CONTROL_METHODS, type CodexCommandDeps } from "./command-handler-deps.js";
import { resolveControlTarget } from "./command-handler-scope.js";

type CodexDiagnosticsCandidate = Omit<
  CodexDiagnosticsTarget,
  | "threadId"
  | "connectionScope"
  | "appServerRuntimeFingerprint"
  | "pendingSupervisionBranch"
  | "authProfileId"
>;

export async function handleCodexDiagnosticsFeedback(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string,
  commandPrefix: string,
): Promise<PluginCommandResult> {
  if (ctx.senderIsOwner !== true) {
    return { text: "Only an owner can send Codex diagnostics." };
  }
  const parsed = parseDiagnosticsArgs(args);
  if (parsed.action === "usage") {
    return { text: formatDiagnosticsUsage(commandPrefix) };
  }
  if (parsed.action === "confirm") {
    return {
      text: await confirmCodexDiagnosticsFeedback(deps, ctx, pluginConfig, parsed.token),
    };
  }
  if (parsed.action === "cancel") {
    return { text: cancelCodexDiagnosticsFeedback(ctx, parsed.token) };
  }
  if (ctx.diagnosticsUploadApproved === true) {
    return {
      text: await sendCodexDiagnosticsFeedbackForContext(deps, ctx, pluginConfig, parsed.note),
    };
  }
  if (ctx.diagnosticsPreviewOnly === true) {
    return {
      text: await previewCodexDiagnosticsFeedbackApproval(deps, ctx, parsed.note),
    };
  }
  return await requestCodexDiagnosticsFeedbackApproval(deps, ctx, parsed.note, commandPrefix);
}

async function requestCodexDiagnosticsFeedbackApproval(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  note: string,
  commandPrefix: string,
): Promise<PluginCommandResult> {
  if (!(await hasAnyCodexDiagnosticsIdentity(ctx))) {
    return {
      text: "Cannot send Codex diagnostics because this command did not include a stable session identity.",
    };
  }
  const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
  if (targets.length === 0) {
    return {
      text: [
        "No Codex thread is attached to this OpenClaw session yet.",
        "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
      ].join("\n"),
    };
  }
  const now = Date.now();
  const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now);
  if (cooldownMessage) {
    return { text: cooldownMessage };
  }
  if (!ctx.senderId) {
    return {
      text: "Cannot send Codex diagnostics because this command did not include a sender identity.",
    };
  }
  const reason = normalizeDiagnosticsReason(note);
  const token = createCodexDiagnosticsConfirmation({
    targets,
    note: reason,
    senderId: ctx.senderId,
    channel: ctx.channel,
    scopeKey: readCodexDiagnosticsCooldownScope(ctx),
    privateRouted: ctx.diagnosticsPrivateRouted === true,
    ...readCodexDiagnosticsConfirmationScope(ctx),
    now,
  });
  const confirmCommand = `${commandPrefix} confirm ${token}`;
  const cancelCommand = `${commandPrefix} cancel ${token}`;
  const displayReason = reason ? escapeCodexChatText(formatCodexTextForDisplay(reason)) : undefined;
  const lines = [
    targets.length === 1 ? "Codex runtime thread detected." : "Codex runtime threads detected.",
    `Codex diagnostics can send ${targets.length === 1 ? "this thread's feedback bundle" : "these threads' feedback bundles"} to OpenAI servers.`,
    "Codex sessions:",
    ...formatCodexDiagnosticsTargetLines(targets),
    ...(displayReason ? [`Note: ${displayReason}`] : []),
    "Included: Codex logs and spawned Codex subthreads when available.",
    `To send: ${confirmCommand}`,
    `To cancel: ${cancelCommand}`,
    "This request expires in 5 minutes.",
  ];
  return {
    text: lines.join("\n"),
    interactive: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Send diagnostics",
              action: { type: "command", command: confirmCommand },
              value: confirmCommand,
              style: "danger",
            },
            {
              label: "Cancel",
              action: { type: "command", command: cancelCommand },
              value: cancelCommand,
              style: "secondary",
            },
          ],
        },
      ],
    },
  };
}

async function previewCodexDiagnosticsFeedbackApproval(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  note: string,
): Promise<string> {
  if (!(await hasAnyCodexDiagnosticsIdentity(ctx))) {
    return "Cannot send Codex diagnostics because this command did not include a stable session identity.";
  }
  const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
  if (targets.length === 0) {
    return [
      "No Codex thread is attached to this OpenClaw session yet.",
      "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
    ].join("\n");
  }
  const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, Date.now(), {
    includeThreadId: false,
  });
  if (cooldownMessage) {
    return cooldownMessage;
  }
  const reason = normalizeDiagnosticsReason(note);
  const displayReason = reason ? escapeCodexChatText(formatCodexTextForDisplay(reason)) : undefined;
  return [
    targets.length === 1 ? "Codex runtime thread detected." : "Codex runtime threads detected.",
    `Approving diagnostics will also send ${targets.length === 1 ? "this thread's feedback bundle" : "these threads' feedback bundles"} to OpenAI servers.`,
    "The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
    ...(displayReason ? [`Note: ${displayReason}`] : []),
    "Included: Codex logs and spawned Codex subthreads when available.",
  ].join("\n");
}

async function confirmCodexDiagnosticsFeedback(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  token: string,
): Promise<string> {
  const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
  if (!pending) {
    return "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.";
  }
  if (!pending.senderId || !ctx.senderId) {
    return "Cannot confirm Codex diagnostics because this command did not include the original sender identity.";
  }
  if (pending.senderId !== ctx.senderId) {
    return "Only the user who requested these Codex diagnostics can confirm the upload.";
  }
  if (pending.channel !== ctx.channel) {
    return "This Codex diagnostics confirmation belongs to a different channel.";
  }
  const scopeMismatch = readCodexDiagnosticsScopeMismatch(pending, ctx);
  if (scopeMismatch) {
    return scopeMismatch.confirmMessage;
  }
  deletePendingCodexDiagnosticsConfirmation(token);
  if (!pending.privateRouted && !(await hasAnyCodexDiagnosticsIdentity(ctx))) {
    return "Cannot send Codex diagnostics because this command did not include a stable session identity.";
  }
  const currentTargets = pending.privateRouted
    ? await resolvePendingCodexDiagnosticsTargets(deps, pending.targets, ctx.config)
    : await resolveCodexDiagnosticsTargets(deps, ctx);
  if (!codexDiagnosticsTargetsMatch(pending.targets, currentTargets)) {
    return "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.";
  }
  return await sendCodexDiagnosticsFeedbackForTargets(
    deps,
    ctx,
    pluginConfig,
    pending.note ?? "",
    currentTargets,
    { cooldownScope: pending.scopeKey },
  );
}

function cancelCodexDiagnosticsFeedback(ctx: PluginCommandContext, token: string): string {
  const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
  if (!pending) {
    return "No pending Codex diagnostics confirmation was found.";
  }
  if (!pending.senderId || !ctx.senderId) {
    return "Cannot cancel Codex diagnostics because this command did not include the original sender identity.";
  }
  if (pending.senderId !== ctx.senderId) {
    return "Only the user who requested these Codex diagnostics can cancel the upload.";
  }
  if (pending.channel !== ctx.channel) {
    return "This Codex diagnostics confirmation belongs to a different channel.";
  }
  const scopeMismatch = readCodexDiagnosticsScopeMismatch(pending, ctx);
  if (scopeMismatch) {
    return scopeMismatch.cancelMessage;
  }
  deletePendingCodexDiagnosticsConfirmation(token);
  return [
    "Codex diagnostics upload canceled.",
    "Codex sessions:",
    ...formatCodexDiagnosticsTargetLines(pending.targets),
  ].join("\n");
}

async function sendCodexDiagnosticsFeedbackForContext(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  note: string,
): Promise<string> {
  if (!(await hasAnyCodexDiagnosticsIdentity(ctx))) {
    return "Cannot send Codex diagnostics because this command did not include a stable session identity.";
  }
  const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
  if (targets.length === 0) {
    return [
      "No Codex thread is attached to this OpenClaw session yet.",
      "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
    ].join("\n");
  }
  return await sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, note, targets);
}

async function sendCodexDiagnosticsFeedbackForTargets(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  note: string,
  targets: CodexDiagnosticsTarget[],
  options: { cooldownScope?: string } = {},
): Promise<string> {
  if (targets.length === 0) {
    return [
      "No Codex thread is attached to this OpenClaw session yet.",
      "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
    ].join("\n");
  }
  const now = Date.now();
  const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now, {
    cooldownScope: options.cooldownScope,
  });
  if (cooldownMessage) {
    return cooldownMessage;
  }
  const reason = normalizeDiagnosticsReason(note);
  const sent: CodexDiagnosticsTarget[] = [];
  const failed: Array<{ target: CodexDiagnosticsTarget; error: string }> = [];
  for (const target of targets) {
    let connection: ReturnType<typeof resolveCodexBindingAppServerConnection>;
    try {
      connection = resolveCodexBindingAppServerConnection({
        binding: target,
        authProfileId: target.authProfileId,
        pluginConfig,
      });
    } catch (error) {
      failed.push({
        target,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const response = await deps.safeCodexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        threadId: target.threadId,
        includeLogs: true,
        tags: buildDiagnosticsTags(ctx),
        ...(reason ? { reason } : {}),
      },
      {
        config: ctx.config,
        agentDir: target.agentDir,
        ...(connection.clientAuthProfileId !== undefined
          ? { authProfileId: connection.clientAuthProfileId }
          : {}),
        ...(connection.usesSupervisionConnection
          ? { startOptions: connection.appServer.start }
          : {}),
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
      },
    );
    if (!response.ok) {
      failed.push({ target, error: response.error });
      continue;
    }
    const responseThreadId = isJsonObject(response.value)
      ? readString(response.value, "threadId")
      : undefined;
    sent.push({ ...target, threadId: responseThreadId ?? target.threadId });
    recordCodexDiagnosticsUpload(target.threadId, ctx, now, options.cooldownScope);
  }
  return formatCodexDiagnosticsUploadResult(sent, failed);
}

async function hasAnyCodexDiagnosticsIdentity(ctx: PluginCommandContext): Promise<boolean> {
  if (await resolveControlTarget(ctx)) {
    return true;
  }
  return (ctx.diagnosticsSessions ?? []).some((session) => Boolean(session.sessionId));
}

async function resolveCodexDiagnosticsTargets(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<CodexDiagnosticsTarget[]> {
  const activeTarget = await resolveControlTarget(ctx);
  const candidates: CodexDiagnosticsCandidate[] = [];
  if (activeTarget) {
    candidates.push({
      identity: activeTarget.identity,
      agentDir: activeTarget.agentDir,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      channel: ctx.channel,
      channelId: ctx.channelId,
      accountId: ctx.accountId,
      messageThreadId: ctx.messageThreadId,
      threadParentId: ctx.threadParentId,
    });
  }
  for (const session of ctx.diagnosticsSessions ?? []) {
    if (!session.sessionId) {
      continue;
    }
    const inventoryAgentId = session.sessionKey
      ? parseAgentSessionKey(session.sessionKey)?.agentId
      : undefined;
    const identity = sessionBindingIdentity({
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      agentId: inventoryAgentId ?? ctx.agentId,
      config: ctx.config,
    });
    candidates.push({
      identity,
      agentDir: resolveAgentDir(ctx.config, identity.agentId),
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      channel: session.channel,
      channelId: session.channelId,
      accountId: session.accountId,
      messageThreadId: session.messageThreadId,
      threadParentId: session.threadParentId,
    });
  }
  const seenBindingKeys = new Set<string>();
  const seenThreadIds = new Set<string>();
  const targets: CodexDiagnosticsTarget[] = [];
  for (const candidate of candidates) {
    const key = bindingStoreKey(candidate.identity);
    if (seenBindingKeys.has(key)) {
      continue;
    }
    seenBindingKeys.add(key);
    const binding = await deps.bindingStore.read(candidate.identity);
    if (!binding?.threadId || seenThreadIds.has(binding.threadId)) {
      continue;
    }
    seenThreadIds.add(binding.threadId);
    targets.push(resolveCodexDiagnosticsTarget(candidate, binding, ctx.config));
  }
  return targets;
}

async function resolvePendingCodexDiagnosticsTargets(
  deps: CodexCommandDeps,
  targets: readonly CodexDiagnosticsTarget[],
  config?: PluginCommandContext["config"],
): Promise<CodexDiagnosticsTarget[]> {
  const resolved: CodexDiagnosticsTarget[] = [];
  for (const target of targets) {
    const binding = await deps.bindingStore.read(target.identity);
    if (!binding?.threadId) {
      continue;
    }
    resolved.push(resolveCodexDiagnosticsTarget(target, binding, config));
  }
  return resolved;
}

function resolveCodexDiagnosticsTarget(
  target: CodexDiagnosticsCandidate | CodexDiagnosticsTarget,
  binding: Pick<
    CodexAppServerThreadBinding,
    | "threadId"
    | "connectionScope"
    | "appServerRuntimeFingerprint"
    | "pendingSupervisionBranch"
    | "authProfileId"
  >,
  config?: PluginCommandContext["config"],
): CodexDiagnosticsTarget {
  // Confirmation re-resolution receives the previous target. Rebuild the candidate so a
  // stale private connection scope or auth profile can never survive a binding change.
  const candidate: CodexDiagnosticsCandidate = {
    identity: target.identity,
    agentDir: target.agentDir,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    channel: target.channel,
    channelId: target.channelId,
    accountId: target.accountId,
    messageThreadId: target.messageThreadId,
    threadParentId: target.threadParentId,
  };
  if (binding.connectionScope === "supervision") {
    return {
      ...candidate,
      threadId: binding.threadId,
      connectionScope: binding.connectionScope,
      appServerRuntimeFingerprint: binding.appServerRuntimeFingerprint,
      pendingSupervisionBranch: binding.pendingSupervisionBranch,
    };
  }
  const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
    authProfileId: binding.authProfileId,
    agentDir: target.agentDir,
    config,
  });
  return {
    ...candidate,
    threadId: binding.threadId,
    authProfileId,
  };
}
