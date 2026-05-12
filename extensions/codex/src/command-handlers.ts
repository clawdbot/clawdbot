import crypto from "node:crypto";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import {
  installCodexComputerUse,
  readCodexComputerUseStatus,
  type CodexComputerUseSetupParams,
} from "./app-server/computer-use.js";
import { isCodexFastServiceTier, type CodexComputerUseConfig } from "./app-server/config.js";
import { listAllCodexAppServerModels } from "./app-server/models.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import { rememberCodexRateLimits } from "./app-server/rate-limit-cache.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import { readCodexAccountAuthOverview } from "./command-account.js";
import {
  buildHelp,
  formatAccount,
  formatComputerUseStatus,
  formatCodexDisplayText,
  formatCodexStatus,
  formatList,
  formatModels,
  formatThreads,
  readString,
} from "./command-formatters.js";
import {
  codexControlRequest,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
  type CodexControlRequestOptions,
  type SafeValue,
} from "./command-rpc.js";
import {
  readCodexConversationBindingData,
  resolveCodexDefaultWorkspaceDir,
  startCodexConversationThread,
} from "./conversation-binding.js";
import {
  formatPermissionsMode,
  parseCodexFastModeArg,
  parseCodexPermissionsModeArg,
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
} from "./conversation-control.js";

export type CodexCommandDeps = {
  codexControlRequest: CodexControlRequestFn;
  listCodexAppServerModels: typeof listAllCodexAppServerModels;
  readCodexStatusProbes: typeof readCodexStatusProbes;
  readCodexAppServerBinding: typeof readCodexAppServerBinding;
  requestOptions: typeof requestOptions;
  safeCodexControlRequest: SafeCodexControlRequestFn;
  writeCodexAppServerBinding: typeof writeCodexAppServerBinding;
  clearCodexAppServerBinding: typeof clearCodexAppServerBinding;
  readCodexComputerUseStatus: typeof readCodexComputerUseStatus;
  installCodexComputerUse: typeof installCodexComputerUse;
  resolveCodexDefaultWorkspaceDir: typeof resolveCodexDefaultWorkspaceDir;
  startCodexConversationThread: typeof startCodexConversationThread;
  readCodexConversationActiveTurn: typeof readCodexConversationActiveTurn;
  setCodexConversationFastMode: typeof setCodexConversationFastMode;
  setCodexConversationModel: typeof setCodexConversationModel;
  setCodexConversationPermissions: typeof setCodexConversationPermissions;
  steerCodexConversationTurn: typeof steerCodexConversationTurn;
  stopCodexConversationTurn: typeof stopCodexConversationTurn;
};

type CodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
  options?: CodexControlRequestOptions,
) => Promise<JsonValue | undefined>;

type SafeCodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
  options?: CodexControlRequestOptions,
) => Promise<SafeValue<JsonValue | undefined>>;

const defaultCodexCommandDeps: CodexCommandDeps = {
  codexControlRequest,
  listCodexAppServerModels: listAllCodexAppServerModels,
  readCodexStatusProbes,
  readCodexAppServerBinding,
  requestOptions,
  safeCodexControlRequest,
  writeCodexAppServerBinding,
  clearCodexAppServerBinding,
  readCodexComputerUseStatus,
  installCodexComputerUse,
  resolveCodexDefaultWorkspaceDir,
  startCodexConversationThread,
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
};

type ParsedBindArgs = {
  threadId?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  help?: boolean;
};

type ParsedComputerUseArgs = {
  action: "status" | "install";
  overrides: Partial<CodexComputerUseConfig>;
  hasOverrides: boolean;
  help?: boolean;
};

type ParsedDiagnosticsArgs =
  | { action: "request"; note: string }
  | { action: "confirm"; token: string }
  | { action: "cancel"; token: string }
  | { action: "usage" };

type CodexDiagnosticsTarget = {
  threadId: string;
  sessionFile: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  channelId?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
};

type PendingCodexDiagnosticsConfirmation = {
  token: string;
  targets: CodexDiagnosticsTarget[];
  note?: string;
  senderId: string;
  channel: string;
  accountId?: string;
  channelId?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sessionKey?: string;
  scopeKey: string;
  privateRouted?: boolean;
  createdAt: number;
};

const CODEX_DIAGNOSTICS_SOURCE = "openclaw-diagnostics";
const CODEX_DIAGNOSTICS_REASON_MAX_CHARS = 2048;
const CODEX_DIAGNOSTICS_COOLDOWN_MS = 60_000;
const CODEX_DIAGNOSTICS_ERROR_MAX_CHARS = 500;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS = 100;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS = 5 * 60_000;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS = 128;
const CODEX_RESUME_SAFE_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const lastCodexDiagnosticsUploadByThread = new Map<string, number>();
const lastCodexDiagnosticsUploadByScope = new Map<string, number>();
const pendingCodexDiagnosticsConfirmations = new Map<string, PendingCodexDiagnosticsConfirmation>();
const pendingCodexDiagnosticsConfirmationTokensByScope = new Map<string, string[]>();

export function resetCodexDiagnosticsFeedbackStateForTests(): void {
  lastCodexDiagnosticsUploadByThread.clear();
  lastCodexDiagnosticsUploadByScope.clear();
  pendingCodexDiagnosticsConfirmations.clear();
  pendingCodexDiagnosticsConfirmationTokensByScope.clear();
}

export async function handleCodexSubcommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> },
): Promise<PluginCommandResult> {
  const deps: CodexCommandDeps = { ...defaultCodexCommandDeps, ...options.deps };
  const [subcommand = "status", ...rest] = splitArgs(ctx.args);
  const normalized = subcommand.toLowerCase();
  if (normalized === "help") {
    return { text: buildHelp() };
  }
  if (normalized === "status") {
    if (rest.length > 0) {
      return { text: "Usage: /codex status" };
    }
    return {
      text: formatCodexStatus(await deps.readCodexStatusProbes(options.pluginConfig, ctx.config)),
    };
  }
  if (normalized === "models") {
    if (rest.length > 0) {
      return { text: "Usage: /codex models" };
    }
    return {
      text: formatModels(
        await deps.listCodexAppServerModels(
          deps.requestOptions(options.pluginConfig, 100, ctx.config),
        ),
      ),
    };
  }
  if (normalized === "threads") {
    return { text: await buildThreads(deps, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "resume") {
    return { text: await resumeThread(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "bind") {
    return await bindConversation(deps, ctx, options.pluginConfig, rest);
  }
  if (normalized === "detach" || normalized === "unbind") {
    if (rest.length > 0) {
      return { text: "Usage: /codex detach" };
    }
    return { text: await detachConversation(deps, ctx) };
  }
  if (normalized === "binding") {
    if (rest.length > 0) {
      return { text: "Usage: /codex binding" };
    }
    return { text: await describeConversationBinding(deps, ctx) };
  }
  if (normalized === "stop") {
    if (rest.length > 0) {
      return { text: "Usage: /codex stop" };
    }
    return { text: await stopConversationTurn(deps, ctx, options.pluginConfig) };
  }
  if (normalized === "steer") {
    return { text: await steerConversationTurn(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "model") {
    return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "fast") {
    return { text: await setConversationFastMode(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "permissions") {
    return { text: await setConversationPermissions(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "compact") {
    return {
      text: await startThreadAction(
        deps,
        ctx,
        options.pluginConfig,
        CODEX_CONTROL_METHODS.compact,
        "compaction",
        rest,
      ),
    };
  }
  if (normalized === "review") {
    return {
      text: await startThreadAction(
        deps,
        ctx,
        options.pluginConfig,
        CODEX_CONTROL_METHODS.review,
        "review",
        rest,
      ),
    };
  }
  if (normalized === "diagnostics") {
    return await handleCodexDiagnosticsFeedback(
      deps,
      ctx,
      options.pluginConfig,
      rest.join(" "),
      "/codex diagnostics",
    );
  }
  if (normalized === "computer-use" || normalized === "computeruse") {
    return {
      text: await handleComputerUseCommand(deps, options.pluginConfig, rest),
    };
  }
  if (normalized === "mcp") {
    if (rest.length > 0) {
      return { text: "Usage: /codex mcp" };
    }
    return {
      text: formatList(
        await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, {
          limit: 100,
        }),
        "MCP servers",
      ),
    };
  }
  if (normalized === "skills") {
    if (rest.length > 0) {
      return { text: "Usage: /codex skills" };
    }
    return {
      text: formatList(
        await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}),
        "Codex skills",
      ),
    };
  }
  if (normalized === "account") {
    if (rest.length > 0) {
      return { text: "Usage: /codex account" };
    }
    const [account, limits] = await Promise.all([
      deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.account, {
        refreshToken: false,
      }),
      deps.safeCodexControlRequest(
        options.pluginConfig,
        CODEX_CONTROL_METHODS.rateLimits,
        undefined,
      ),
    ]);
    if (limits.ok) {
      rememberCodexRateLimits(limits.value);
    }
    return {
      text: formatAccount(
        account,
        limits,
        await readCodexAccountAuthOverview({
          ctx,
          pluginConfig: options.pluginConfig,
          safeCodexControlRequest: deps.safeCodexControlRequest,
          account,
          limits,
        }),
      ),
    };
  }
  return { text: `Unknown Codex command: ${formatCodexDisplayText(subcommand)}\n\n${buildHelp()}` };
}

async function handleComputerUseCommand(
  deps: CodexCommandDeps,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const parsed = parseComputerUseArgs(args);
  if (parsed.help) {
    return [
      "Usage: /codex computer-use [status|install] [--source <marketplace-source>] [--marketplace-path <path>] [--marketplace <name>]",
      "Checks or installs the configured Codex Computer Use plugin through app-server.",
    ].join("\n");
  }
  const params: CodexComputerUseSetupParams = {
    pluginConfig,
    forceEnable: parsed.action === "install" || parsed.hasOverrides,
    ...(Object.keys(parsed.overrides).length > 0 ? { overrides: parsed.overrides } : {}),
  };
  if (parsed.action === "install") {
    return formatComputerUseStatus(await deps.installCodexComputerUse(params));
  }
  return formatComputerUseStatus(await deps.readCodexComputerUseStatus(params));
}

async function bindConversation(
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
  if (!ctx.sessionFile) {
    return {
      text: "Cannot bind Codex because this command did not include an OpenClaw session file.",
    };
  }
  const workspaceDir = parsed.cwd ?? deps.resolveCodexDefaultWorkspaceDir(pluginConfig);
  const existingBinding = await deps.readCodexAppServerBinding(ctx.sessionFile);
  const authProfileId = existingBinding?.authProfileId;
  const startParams: Parameters<CodexCommandDeps["startCodexConversationThread"]>[0] = {
    pluginConfig,
    config: ctx.config,
    sessionFile: ctx.sessionFile,
    workspaceDir,
    threadId: parsed.threadId,
    model: parsed.model,
    modelProvider: parsed.provider,
  };
  if (authProfileId) {
    startParams.authProfileId = authProfileId;
  }
  const data = await deps.startCodexConversationThread(startParams);
  const binding = await deps.readCodexAppServerBinding(ctx.sessionFile);
  const threadId = binding?.threadId ?? parsed.threadId ?? "new thread";
  const summary = `Codex app-server thread ${formatCodexDisplayText(threadId)} in ${formatCodexDisplayText(workspaceDir)}`;
  let request: Awaited<ReturnType<PluginCommandContext["requestConversationBinding"]>>;
  try {
    request = await ctx.requestConversationBinding({
      summary,
      detachHint: "/codex detach",
      data,
    });
  } catch (error) {
    await deps.clearCodexAppServerBinding(ctx.sessionFile);
    throw error;
  }
  if (request.status === "bound") {
    return {
      text: `Bound this conversation to Codex thread ${formatCodexDisplayText(
        threadId,
      )} in ${formatCodexDisplayText(workspaceDir)}.`,
    };
  }
  if (request.status === "pending") {
    return request.reply;
  }
  await deps.clearCodexAppServerBinding(ctx.sessionFile);
  return { text: formatCodexDisplayText(request.message) };
}

async function detachConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  const detached = await ctx.detachConversationBinding();
  if (data) {
    await deps.clearCodexAppServerBinding(data.sessionFile);
  } else if (ctx.sessionFile) {
    await deps.clearCodexAppServerBinding(ctx.sessionFile);
  }
  return detached.removed
    ? "Detached this conversation from Codex."
    : "No Codex conversation binding was attached.";
}

async function describeConversationBinding(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  if (!current || !data) {
    return "No Codex conversation binding is attached.";
  }
  const threadBinding = await deps.readCodexAppServerBinding(data.sessionFile);
  const active = deps.readCodexConversationActiveTurn(data.sessionFile);
  return [
    "Codex conversation binding:",
    `- Thread: ${formatCodexDisplayText(threadBinding?.threadId ?? "unknown")}`,
    `- Workspace: ${formatCodexDisplayText(data.workspaceDir)}`,
    `- Model: ${formatCodexDisplayText(threadBinding?.model ?? "default")}`,
    `- Fast: ${isCodexFastServiceTier(threadBinding?.serviceTier) ? "on" : "off"}`,
    `- Permissions: ${threadBinding ? formatPermissionsMode(threadBinding) : "default"}`,
    `- Active run: ${formatCodexDisplayText(active ? active.turnId : "none")}`,
    `- Session: ${formatCodexDisplayText(data.sessionFile)}`,
  ].join("\n");
}

async function buildThreads(
  deps: CodexCommandDeps,
  pluginConfig: unknown,
  filter: string,
): Promise<string> {
  const response = await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listThreads, {
    limit: 10,
    ...(filter.trim() ? { searchTerm: filter.trim() } : {}),
  });
  return formatThreads(response);
}

async function resumeThread(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const [threadId] = args;
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId || args.length !== 1) {
    return "Usage: /codex resume <thread-id>";
  }
  if (!ctx.sessionFile) {
    return "Cannot attach a Codex thread because this command did not include an OpenClaw session file.";
  }
  const response = await deps.codexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.resumeThread,
    {
      threadId: normalizedThreadId,
      persistExtendedHistory: true,
    },
  );
  const thread = isJsonObject(response) && isJsonObject(response.thread) ? response.thread : {};
  const effectiveThreadId = readString(thread, "id") ?? normalizedThreadId;
  await deps.writeCodexAppServerBinding(ctx.sessionFile, {
    threadId: effectiveThreadId,
    cwd: readString(thread, "cwd") ?? "",
    model: isJsonObject(response) ? readString(response, "model") : undefined,
    modelProvider: isJsonObject(response) ? readString(response, "modelProvider") : undefined,
  });
  return `Attached this OpenClaw session to Codex thread ${formatCodexDisplayText(
    effectiveThreadId,
  )}.`;
}

async function stopConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot stop Codex because this command did not include an OpenClaw session file.";
  }
  return (await deps.stopCodexConversationTurn({ sessionFile, pluginConfig })).message;
}

async function steerConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  message: string,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot steer Codex because this command did not include an OpenClaw session file.";
  }
  return (
    await deps.steerCodexConversationTurn({
      sessionFile,
      pluginConfig,
      message,
    })
  ).message;
}

async function setConversationModel(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex model <model>";
  }
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex model because this command did not include an OpenClaw session file.";
  }
  const [model = ""] = args;
  const normalized = model.trim();
  if (!normalized) {
    const binding = await deps.readCodexAppServerBinding(sessionFile);
    return binding?.model
      ? `Codex model: ${formatCodexDisplayText(binding.model)}`
      : "Usage: /codex model <model>";
  }
  return await deps.setCodexConversationModel({
    sessionFile,
    pluginConfig,
    model: normalized,
  });
}

async function setConversationFastMode(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex fast [on|off|status]";
  }
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex fast mode because this command did not include an OpenClaw session file.";
  }
  const value = args[0];
  const parsed = parseCodexFastModeArg(value);
  if (value && parsed == null && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex fast [on|off|status]";
  }
  return await deps.setCodexConversationFastMode({
    sessionFile,
    pluginConfig,
    enabled: parsed,
  });
}

async function setConversationPermissions(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex permissions because this command did not include an OpenClaw session file.";
  }
  const value = args[0];
  const parsed = parseCodexPermissionsModeArg(value);
  if (value && !parsed && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  return await deps.setCodexConversationPermissions({
    sessionFile,
    pluginConfig,
    mode: parsed,
  });
}

async function resolveControlSessionFile(ctx: PluginCommandContext): Promise<string | undefined> {
  const binding = await ctx.getCurrentConversationBinding();
  return readCodexConversationBindingData(binding)?.sessionFile ?? ctx.sessionFile;
}

async function handleCodexDiagnosticsFeedback(
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
  if (!(await hasAnyCodexDiagnosticsSessionFile(ctx))) {
    return {
      text: "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.",
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
            { label: "Send diagnostics", value: confirmCommand, style: "danger" },
            { label: "Cancel", value: cancelCommand, style: "secondary" },
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
  if (!(await hasAnyCodexDiagnosticsSessionFile(ctx))) {
    return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
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
  if (!pending.privateRouted && !(await hasAnyCodexDiagnosticsSessionFile(ctx))) {
    return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
  }
  const currentTargets = pending.privateRouted
    ? await resolvePendingCodexDiagnosticsTargets(deps, pending.targets)
    : await resolveCodexDiagnosticsTargets(deps, ctx);
  if (!codexDiagnosticsTargetsMatch(pending.targets, currentTargets)) {
    return "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.";
  }
  return await sendCodexDiagnosticsFeedbackForTargets(
    deps,
    ctx,
    pluginConfig,
    pending.note ?? "",
    pending.targets,
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
  if (!(await hasAnyCodexDiagnosticsSessionFile(ctx))) {
    return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
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
): Promise<string> {
  if (targets.length === 0) {
    return [
      "No Codex thread is attached to this OpenClaw session yet.",
      "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
    ].join("\n");
  }
  const now = Date.now();
  const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now);
  if (cooldownMessage) {
    return cooldownMessage;
  }
  const reason = normalizeDiagnosticsReason(note);
  const sent: CodexDiagnosticsTarget[] = [];
  const failed: Array<{ target: CodexDiagnosticsTarget; error: string }> = [];
  for (const target of targets) {
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
    );
    if (!response.ok) {
      failed.push({ target, error: response.error });
      continue;
    }
    const responseThreadId = isJsonObject(response.value)
      ? readString(response.value, "threadId")
      : undefined;
    sent.push({ ...target, threadId: responseThreadId ?? target.threadId });
    recordCodexDiagnosticsUpload(target.threadId, ctx, now);
  }
  return formatCodexDiagnosticsUploadResult(sent, failed);
}

async function hasAnyCodexDiagnosticsSessionFile(ctx: PluginCommandContext): Promise<boolean> {
  if (await resolveControlSessionFile(ctx)) {
    return true;
  }
  return (ctx.diagnosticsSessions ?? []).some((session) => Boolean(session.sessionFile));
}

async function resolveCodexDiagnosticsTargets(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<CodexDiagnosticsTarget[]> {
  const activeSessionFile = await resolveControlSessionFile(ctx);
  const candidates: CodexDiagnosticsTarget[] = [];
  if (activeSessionFile) {
    candidates.push({
      threadId: "",
      sessionFile: activeSessionFile,
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
    if (!session.sessionFile) {
      continue;
    }
    candidates.push({
      threadId: "",
      sessionFile: session.sessionFile,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      channel: session.channel,
      channelId: session.channelId,
      accountId: session.accountId,
      messageThreadId: session.messageThreadId,
      threadParentId: session.threadParentId,
    });
  }
  const seenSessionFiles = new Set<string>();
  const seenThreadIds = new Set<string>();
  const targets: CodexDiagnosticsTarget[] = [];
  for (const candidate of candidates) {
    if (seenSessionFiles.has(candidate.sessionFile)) {
      continue;
    }
    seenSessionFiles.add(candidate.sessionFile);
    const binding = await deps.readCodexAppServerBinding(candidate.sessionFile);
    if (!binding?.threadId || seenThreadIds.has(binding.threadId)) {
      continue;
    }
    seenThreadIds.add(binding.threadId);
    targets.push({ ...candidate, threadId: binding.threadId });
  }
  return targets;
}

async function resolvePendingCodexDiagnosticsTargets(
  deps: CodexCommandDeps,
  targets: readonly CodexDiagnosticsTarget[],
): Promise<CodexDiagnosticsTarget[]> {
  const resolved: CodexDiagnosticsTarget[] = [];
  for (const target of targets) {
    const binding = await deps.readCodexAppServerBinding(target.sessionFile);
    if (!binding?.threadId) {
      continue;
    }
    resolved.push({ ...target, threadId: binding.threadId });
  }
  return resolved;
}

function codexDiagnosticsTargetsMatch(
  expected: readonly CodexDiagnosticsTarget[],
  actual: readonly CodexDiagnosticsTarget[],
): boolean {
  const expectedThreadIds = expected.map((target) => target.threadId).toSorted();
  const actualThreadIds = actual.map((target) => target.threadId).toSorted();
  return (
    expectedThreadIds.length === actualThreadIds.length &&
    expectedThreadIds.every((threadId, index) => threadId === actualThreadIds[index])
  );
}

function formatCodexDiagnosticsUploadResult(
  sent: readonly CodexDiagnosticsTarget[],
  failed: ReadonlyArray<{ target: CodexDiagnosticsTarget; error: string }>,
): string {
  const lines: string[] = [];
  if (sent.length > 0) {
    lines.push("Codex diagnostics sent to OpenAI servers:");
    lines.push(...formatCodexDiagnosticsTargetLines(sent));
    lines.push("Included Codex logs and spawned Codex subthreads when available.");
  }
  if (failed.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("Could not send Codex diagnostics:");
    lines.push(
      ...failed.map(
        ({ target, error }) =>
          `${formatCodexDiagnosticsTargetLine(target)}: ${formatCodexErrorForDisplay(error)}`,
      ),
    );
    lines.push("Inspect locally:");
    lines.push(
      ...failed.map(({ target }) => `- ${formatCodexResumeCommandForDisplay(target.threadId)}`),
    );
  }
  return lines.join("\n");
}

function formatCodexDiagnosticsTargetLines(targets: readonly CodexDiagnosticsTarget[]): string[] {
  return targets.flatMap((target, index) => {
    const lines = formatCodexDiagnosticsTargetBlock(target, index);
    return index < targets.length - 1 ? [...lines, ""] : lines;
  });
}

function formatCodexDiagnosticsTargetBlock(
  target: CodexDiagnosticsTarget,
  index: number,
): string[] {
  const lines = [`Session ${index + 1}`];
  if (target.channel) {
    lines.push(`Channel: ${formatCodexValueForDisplay(target.channel)}`);
  }
  if (target.sessionKey) {
    lines.push(`OpenClaw session key: ${formatCodexCopyableValueForDisplay(target.sessionKey)}`);
  }
  if (target.sessionId) {
    lines.push(`OpenClaw session id: ${formatCodexCopyableValueForDisplay(target.sessionId)}`);
  }
  lines.push(`Codex thread id: ${formatCodexCopyableValueForDisplay(target.threadId)}`);
  lines.push(`Inspect locally: ${formatCodexResumeCommandForDisplay(target.threadId)}`);
  return lines;
}

function formatCodexDiagnosticsTargetLine(target: CodexDiagnosticsTarget): string {
  const parts: string[] = [];
  if (target.channel) {
    parts.push(`channel ${formatCodexValueForDisplay(target.channel)}`);
  }
  const sessionLabel = target.sessionId || target.sessionKey;
  if (sessionLabel) {
    parts.push(`OpenClaw session ${formatCodexValueForDisplay(sessionLabel)}`);
  }
  parts.push(`Codex thread ${formatCodexThreadIdForDisplay(target.threadId)}`);
  return `- ${parts.join(", ")}`;
}

function normalizeDiagnosticsReason(note: string): string | undefined {
  const normalized = normalizeOptionalString(note);
  return normalized ? normalized.slice(0, CODEX_DIAGNOSTICS_REASON_MAX_CHARS) : undefined;
}

function parseDiagnosticsArgs(args: string): ParsedDiagnosticsArgs {
  const [action, token, ...extra] = splitArgs(args);
  const normalizedAction = action?.toLowerCase();
  if (
    (normalizedAction === "confirm" || normalizedAction === "--confirm") &&
    token &&
    extra.length === 0
  ) {
    return { action: "confirm", token };
  }
  if (
    (normalizedAction === "cancel" || normalizedAction === "--cancel") &&
    token &&
    extra.length === 0
  ) {
    return { action: "cancel", token };
  }
  if (
    normalizedAction === "confirm" ||
    normalizedAction === "--confirm" ||
    normalizedAction === "cancel" ||
    normalizedAction === "--cancel"
  ) {
    return { action: "usage" };
  }
  return { action: "request", note: args };
}

function formatDiagnosticsUsage(commandPrefix: string): string {
  return [
    `Usage: ${commandPrefix} [note]`,
    `Usage: ${commandPrefix} confirm <token>`,
    `Usage: ${commandPrefix} cancel <token>`,
  ].join("\n");
}

function createCodexDiagnosticsConfirmation(params: {
  targets: CodexDiagnosticsTarget[];
  note?: string;
  senderId: string;
  channel: string;
  accountId?: string;
  channelId?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sessionKey?: string;
  scopeKey: string;
  privateRouted?: boolean;
  now: number;
}): string {
  prunePendingCodexDiagnosticsConfirmations(params.now);
  if (
    !pendingCodexDiagnosticsConfirmationTokensByScope.has(params.scopeKey) &&
    pendingCodexDiagnosticsConfirmationTokensByScope.size >=
      CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES
  ) {
    const oldestScopeKey = pendingCodexDiagnosticsConfirmationTokensByScope.keys().next().value;
    if (typeof oldestScopeKey === "string") {
      deletePendingCodexDiagnosticsConfirmationScope(oldestScopeKey);
    }
  }
  const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(params.scopeKey) ?? [];
  while (scopeTokens.length >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE) {
    const oldestToken = scopeTokens.shift();
    if (!oldestToken) {
      break;
    }
    pendingCodexDiagnosticsConfirmations.delete(oldestToken);
  }
  const token = crypto.randomBytes(6).toString("hex");
  scopeTokens.push(token);
  pendingCodexDiagnosticsConfirmationTokensByScope.set(params.scopeKey, scopeTokens);
  pendingCodexDiagnosticsConfirmations.set(token, {
    token,
    targets: params.targets,
    note: params.note,
    senderId: params.senderId,
    channel: params.channel,
    accountId: params.accountId,
    channelId: params.channelId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    sessionKey: params.sessionKey,
    scopeKey: params.scopeKey,
    ...(params.privateRouted === undefined ? {} : { privateRouted: params.privateRouted }),
    createdAt: params.now,
  });
  return token;
}

function readCodexDiagnosticsConfirmationScope(ctx: PluginCommandContext): {
  accountId?: string;
  channelId?: string;
  messageThreadId?: string;
  threadParentId?: string;
  sessionKey?: string;
} {
  return {
    accountId: normalizeCodexDiagnosticsScopeField(ctx.accountId),
    channelId: normalizeCodexDiagnosticsScopeField(ctx.channelId),
    messageThreadId:
      typeof ctx.messageThreadId === "string" || typeof ctx.messageThreadId === "number"
        ? normalizeCodexDiagnosticsScopeField(String(ctx.messageThreadId))
        : undefined,
    threadParentId: normalizeCodexDiagnosticsScopeField(ctx.threadParentId),
    sessionKey: normalizeCodexDiagnosticsScopeField(ctx.sessionKey),
  };
}

function readCodexDiagnosticsScopeMismatch(
  pending: PendingCodexDiagnosticsConfirmation,
  ctx: PluginCommandContext,
):
  | {
      confirmMessage: string;
      cancelMessage: string;
    }
  | undefined {
  const current = readCodexDiagnosticsConfirmationScope(ctx);
  if (pending.accountId !== current.accountId) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different account.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different account.",
    };
  }
  if (pending.privateRouted) {
    return undefined;
  }
  if (pending.channelId !== current.channelId) {
    return {
      confirmMessage:
        "This Codex diagnostics confirmation belongs to a different channel instance.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different channel instance.",
    };
  }
  if (pending.messageThreadId !== current.messageThreadId) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different thread.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different thread.",
    };
  }
  if (pending.threadParentId !== current.threadParentId) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different parent thread.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different parent thread.",
    };
  }
  if (pending.sessionKey !== current.sessionKey) {
    return {
      confirmMessage: "This Codex diagnostics confirmation belongs to a different session.",
      cancelMessage: "This Codex diagnostics confirmation belongs to a different session.",
    };
  }
  return undefined;
}

function readPendingCodexDiagnosticsConfirmation(
  token: string,
  now: number,
): PendingCodexDiagnosticsConfirmation | undefined {
  prunePendingCodexDiagnosticsConfirmations(now);
  return pendingCodexDiagnosticsConfirmations.get(token);
}

function prunePendingCodexDiagnosticsConfirmations(now: number): void {
  for (const [token, pending] of pendingCodexDiagnosticsConfirmations) {
    if (now - pending.createdAt >= CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS) {
      deletePendingCodexDiagnosticsConfirmation(token);
    }
  }
}

function deletePendingCodexDiagnosticsConfirmation(token: string): void {
  const pending = pendingCodexDiagnosticsConfirmations.get(token);
  pendingCodexDiagnosticsConfirmations.delete(token);
  if (!pending) {
    return;
  }
  const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(pending.scopeKey);
  if (!scopeTokens) {
    return;
  }
  const tokenIndex = scopeTokens.indexOf(token);
  if (tokenIndex >= 0) {
    scopeTokens.splice(tokenIndex, 1);
  }
  if (scopeTokens.length === 0) {
    pendingCodexDiagnosticsConfirmationTokensByScope.delete(pending.scopeKey);
  }
}

function deletePendingCodexDiagnosticsConfirmationScope(scopeKey: string): void {
  const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(scopeKey) ?? [];
  for (const token of scopeTokens) {
    pendingCodexDiagnosticsConfirmations.delete(token);
  }
  pendingCodexDiagnosticsConfirmationTokensByScope.delete(scopeKey);
}

function buildDiagnosticsTags(ctx: PluginCommandContext): Record<string, string> {
  const tags: Record<string, string> = {
    source: CODEX_DIAGNOSTICS_SOURCE,
  };
  addTag(tags, "channel", ctx.channel);
  return tags;
}

function addTag(tags: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    tags[key] = value.trim();
  }
}

function formatCodexThreadIdForDisplay(threadId: string): string {
  return escapeCodexChatText(formatCodexTextForDisplay(threadId));
}

function formatCodexValueForDisplay(value: string): string {
  return escapeCodexChatText(formatCodexTextForDisplay(value));
}

function formatCodexCopyableValueForDisplay(value: string): string {
  const safe = formatCodexTextForDisplay(value);
  if (CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safe)) {
    return `\`${safe}\``;
  }
  return escapeCodexChatText(safe);
}

function formatCodexTextForDisplay(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
  }
  safe = safe.trim();
  return safe || "<unknown>";
}

function escapeCodexChatText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "\uff20")
    .replaceAll("`", "\uff40")
    .replaceAll("[", "\uff3b")
    .replaceAll("]", "\uff3d")
    .replaceAll("(", "\uff08")
    .replaceAll(")", "\uff09")
    .replaceAll("*", "\u2217")
    .replaceAll("_", "\uff3f")
    .replaceAll("~", "\uff5e")
    .replaceAll("|", "\uff5c");
}

function readCodexDiagnosticsCooldownMs(threadId: string, now: number): number {
  const lastSentAt = lastCodexDiagnosticsUploadByThread.get(threadId);
  if (!lastSentAt) {
    return 0;
  }
  const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
  if (remainingMs === 0) {
    lastCodexDiagnosticsUploadByThread.delete(threadId);
  }
  return remainingMs;
}

function readCodexDiagnosticsTargetsCooldownMessage(
  targets: readonly CodexDiagnosticsTarget[],
  ctx: PluginCommandContext,
  now: number,
  options: { includeThreadId?: boolean } = {},
): string | undefined {
  for (const target of targets) {
    const cooldownMs = readCodexDiagnosticsCooldownMs(target.threadId, now);
    if (cooldownMs > 0) {
      if (options.includeThreadId === false) {
        return `Codex diagnostics were already sent for one of these Codex threads recently. Try again in ${Math.ceil(
          cooldownMs / 1000,
        )}s.`;
      }
      const displayThreadId = formatCodexThreadIdForDisplay(target.threadId);
      return `Codex diagnostics were already sent for thread ${displayThreadId} recently. Try again in ${Math.ceil(
        cooldownMs / 1000,
      )}s.`;
    }
  }
  const scopeCooldownMs = readCodexDiagnosticsScopeCooldownMs(
    readCodexDiagnosticsCooldownScope(ctx),
    now,
  );
  if (scopeCooldownMs > 0) {
    return `Codex diagnostics were already sent for this account or channel recently. Try again in ${Math.ceil(
      scopeCooldownMs / 1000,
    )}s.`;
  }
  return undefined;
}

function readCodexDiagnosticsScopeCooldownMs(scope: string, now: number): number {
  const lastSentAt = lastCodexDiagnosticsUploadByScope.get(scope);
  if (!lastSentAt) {
    return 0;
  }
  const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
  if (remainingMs === 0) {
    lastCodexDiagnosticsUploadByScope.delete(scope);
  }
  return remainingMs;
}

function recordCodexDiagnosticsUpload(
  threadId: string,
  ctx: PluginCommandContext,
  now: number,
): void {
  pruneCodexDiagnosticsCooldowns(now);
  recordBoundedCodexDiagnosticsCooldown(
    lastCodexDiagnosticsUploadByScope,
    readCodexDiagnosticsCooldownScope(ctx),
    CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES,
    now,
  );
  recordBoundedCodexDiagnosticsCooldown(
    lastCodexDiagnosticsUploadByThread,
    threadId,
    CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS,
    now,
  );
}

function recordBoundedCodexDiagnosticsCooldown(
  map: Map<string, number>,
  key: string,
  maxSize: number,
  now: number,
): void {
  if (!map.has(key)) {
    while (map.size >= maxSize) {
      const oldestKey = map.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      map.delete(oldestKey);
    }
  }
  map.set(key, now);
}

function readCodexDiagnosticsCooldownScope(ctx: PluginCommandContext): string {
  const scope = readCodexDiagnosticsConfirmationScope(ctx);
  const payload = JSON.stringify({
    accountId: scope.accountId ?? null,
    channelId: scope.channelId ?? null,
    sessionKey: scope.sessionKey ?? null,
    messageThreadId: scope.messageThreadId ?? null,
    threadParentId: scope.threadParentId ?? null,
    senderId: normalizeCodexDiagnosticsScopeField(ctx.senderId) ?? null,
    channel: normalizeCodexDiagnosticsScopeField(ctx.channel) ?? "",
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function pruneCodexDiagnosticsCooldowns(now: number): void {
  pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByThread, now);
  pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByScope, now);
}

function pruneCodexDiagnosticsCooldownMap(map: Map<string, number>, now: number): void {
  for (const [key, lastSentAt] of map) {
    if (now - lastSentAt >= CODEX_DIAGNOSTICS_COOLDOWN_MS) {
      map.delete(key);
    }
  }
}

function formatCodexErrorForDisplay(error: string): string {
  const safe = formatCodexTextForDisplay(error).slice(0, CODEX_DIAGNOSTICS_ERROR_MAX_CHARS);
  return escapeCodexChatText(safe) || "unknown error";
}

function formatCodexResumeCommandForDisplay(threadId: string): string {
  const safeThreadId = formatCodexTextForDisplay(threadId);
  if (!CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safeThreadId)) {
    return "run codex resume and paste the thread id shown above";
  }
  return `\`codex resume ${safeThreadId}\``;
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x001f ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

function normalizeCodexDiagnosticsScopeField(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS) {
    return normalized;
  }
  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

async function startThreadAction(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  method: typeof CODEX_CONTROL_METHODS.compact | typeof CODEX_CONTROL_METHODS.review,
  label: string,
  args: string[],
): Promise<string> {
  if (args.length > 0) {
    return `Usage: /codex ${label === "compaction" ? "compact" : label}`;
  }
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return `Cannot start Codex ${label} because this command did not include an OpenClaw session file.`;
  }
  const binding = await deps.readCodexAppServerBinding(sessionFile);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  if (method === CODEX_CONTROL_METHODS.review) {
    await deps.codexControlRequest(pluginConfig, method, {
      threadId: binding.threadId,
      target: { type: "uncommittedChanges" },
    });
  } else {
    await deps.codexControlRequest(pluginConfig, method, { threadId: binding.threadId });
  }
  return `Started Codex ${label} for thread ${formatCodexDisplayText(binding.threadId)}.`;
}

function splitArgs(value: string | undefined): string[] {
  const input = value ?? "";
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (escaping) {
    current += "\\";
  }
  if (tokenStarted) {
    args.push(current);
  }
  return args;
}

function parseBindArgs(args: string[]): ParsedBindArgs {
  const parsed: ParsedBindArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--cwd") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.cwd !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.cwd = value;
      index += 1;
      continue;
    }
    if (arg === "--model") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.model !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.model = value;
      index += 1;
      continue;
    }
    if (arg === "--provider" || arg === "--model-provider") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.provider !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.provider = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && !parsed.threadId) {
      parsed.threadId = arg;
      continue;
    }
    parsed.help = true;
  }
  parsed.threadId = normalizeOptionalString(parsed.threadId);
  parsed.cwd = normalizeOptionalString(parsed.cwd);
  parsed.model = normalizeOptionalString(parsed.model);
  parsed.provider = normalizeOptionalString(parsed.provider);
  return parsed;
}

function parseComputerUseArgs(args: string[]): ParsedComputerUseArgs {
  const parsed: ParsedComputerUseArgs = {
    action: "status",
    overrides: {},
    hasOverrides: false,
  };
  let sawAction = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "status" || arg === "install") {
      if (sawAction) {
        parsed.help = true;
        continue;
      }
      sawAction = true;
      parsed.action = arg;
      continue;
    }
    if (arg === "--source" || arg === "--marketplace-source") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.marketplaceSource !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplaceSource = value;
      index += 1;
      continue;
    }
    if (arg === "--marketplace-path" || arg === "--path") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.marketplacePath !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplacePath = value;
      index += 1;
      continue;
    }
    if (arg === "--marketplace") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.marketplaceName !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.marketplaceName = value;
      index += 1;
      continue;
    }
    if (arg === "--plugin") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.pluginName !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.pluginName = value;
      index += 1;
      continue;
    }
    if (arg === "--server" || arg === "--mcp-server") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.overrides.mcpServerName !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.overrides.mcpServerName = value;
      index += 1;
      continue;
    }
    parsed.help = true;
  }
  parsed.overrides = normalizeComputerUseStringOverrides(parsed.overrides);
  parsed.hasOverrides = Object.values(parsed.overrides).some(Boolean);
  return parsed;
}

function readRequiredOptionValue(args: string[], index: number): string | undefined {
  const value = args[index + 1];
  const normalized = value?.trim();
  if (!normalized || normalized.startsWith("-")) {
    return undefined;
  }
  return value;
}

function normalizeComputerUseStringOverrides(
  overrides: Partial<CodexComputerUseConfig>,
): Partial<CodexComputerUseConfig> {
  const normalized: Partial<CodexComputerUseConfig> = {};
  const marketplaceSource = normalizeOptionalString(overrides.marketplaceSource);
  if (marketplaceSource) {
    normalized.marketplaceSource = marketplaceSource;
  }
  const marketplacePath = normalizeOptionalString(overrides.marketplacePath);
  if (marketplacePath) {
    normalized.marketplacePath = marketplacePath;
  }
  const marketplaceName = normalizeOptionalString(overrides.marketplaceName);
  if (marketplaceName) {
    normalized.marketplaceName = marketplaceName;
  }
  const pluginName = normalizeOptionalString(overrides.pluginName);
  if (pluginName) {
    normalized.pluginName = pluginName;
  }
  const mcpServerName = normalizeOptionalString(overrides.mcpServerName);
  if (mcpServerName) {
    normalized.mcpServerName = mcpServerName;
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
