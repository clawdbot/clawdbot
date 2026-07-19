// Codex plugin module implements command handlers behavior.
import crypto from "node:crypto";
import { resolveAgentDir, resolveSessionAgentIds } from "openclaw/plugin-sdk/agent-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "openclaw/plugin-sdk/model-session-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import {
  installCodexComputerUse,
  readCodexComputerUseStatus,
  type CodexComputerUseSetupParams,
} from "./app-server/computer-use.js";
import { isCodexFastServiceTier, type CodexComputerUseConfig } from "./app-server/config.js";
import { listAllCodexAppServerModels } from "./app-server/models.js";
import { assertCodexThreadResumeResponse } from "./app-server/protocol-validators.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import {
  resolveCodexNativeExecutionBlock,
  resolveCodexNativeSandboxBlock,
} from "./app-server/sandbox-guard.js";
import {
  assertCodexBindingMayBeReplaced,
  bindingStoreKey,
  createCodexSessionGenerationSupersededError,
  normalizeCodexAppServerBindingModelProvider,
  reclaimCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import { readCodexAccountAuthOverview } from "./command-account.js";
import { canMutateCodexHost, CODEX_NATIVE_EXECUTION_AUTH_ERROR } from "./command-authorization.js";
import {
  codexDiagnosticsFeedbackState,
  type CodexDiagnosticsTarget,
  type PendingCodexDiagnosticsConfirmation,
} from "./command-diagnostics-state.js";
import {
  buildHelp,
  formatAccount,
  formatComputerUseStatus,
  formatCodexDisplayText,
  formatCodexStatus,
  formatList,
  formatModels,
  formatSkills,
  formatThreads,
  readString,
} from "./command-formatters.js";
import {
  handleCodexPluginsSubcommand,
  type CodexPluginsManagementIO,
} from "./command-plugins-management.js";
import {
  buildCodexCommandPickerPresentation,
  type CodexCommandPickerButton,
} from "./command-presentation.js";
import {
  codexControlRequest,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
  type CodexControlRequestOptions,
  type SafeValue,
} from "./command-rpc.js";
import {
  createCodexCliNodeConversationBindingData,
  createCodexConversationBindingData,
  readCodexConversationBindingData,
  resolveCodexDefaultWorkspaceDir,
} from "./conversation-binding-data.js";
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
import {
  formatCodexCliSessions,
  listCodexCliSessionsOnNode,
  resolveCodexCliSessionForBindingOnNode,
} from "./node-cli-sessions.js";

type CodexCommandDeps = {
  bindingStore: CodexAppServerBindingStore;
  codexControlRequest: CodexControlRequestFn;
  listCodexAppServerModels: typeof listAllCodexAppServerModels;
  readCodexStatusProbes: typeof readCodexStatusProbes;
  requestOptions: typeof requestOptions;
  safeCodexControlRequest: SafeCodexControlRequestFn;
  readCodexComputerUseStatus: typeof readCodexComputerUseStatus;
  installCodexComputerUse: typeof installCodexComputerUse;
  resolveCodexDefaultWorkspaceDir: typeof resolveCodexDefaultWorkspaceDir;
  readCodexConversationActiveTurn: typeof readCodexConversationActiveTurn;
  setCodexConversationFastMode: typeof setCodexConversationFastMode;
  setCodexConversationModel: typeof setCodexConversationModel;
  setCodexConversationPermissions: typeof setCodexConversationPermissions;
  steerCodexConversationTurn: typeof steerCodexConversationTurn;
  stopCodexConversationTurn: typeof stopCodexConversationTurn;
  listCodexCliSessionsOnNode: ListCodexCliSessionsOnNodeFn;
  resolveCodexCliSessionForBindingOnNode: ResolveCodexCliSessionForBindingOnNodeFn;
  codexPluginsManagementIo?: CodexPluginsManagementIO;
};

export type CodexCommandDepsOverride = Pick<CodexCommandDeps, "bindingStore"> &
  Partial<Omit<CodexCommandDeps, "bindingStore">>;

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

type ListCodexCliSessionsOnNodeFn = (
  params: Omit<Parameters<typeof listCodexCliSessionsOnNode>[0], "runtime">,
) => ReturnType<typeof listCodexCliSessionsOnNode>;

type ResolveCodexCliSessionForBindingOnNodeFn = (
  params: Omit<Parameters<typeof resolveCodexCliSessionForBindingOnNode>[0], "runtime">,
) => ReturnType<typeof resolveCodexCliSessionForBindingOnNode>;

const defaultCodexCommandDeps: Omit<CodexCommandDeps, "bindingStore"> = {
  codexControlRequest,
  listCodexAppServerModels: listAllCodexAppServerModels,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
  readCodexComputerUseStatus,
  installCodexComputerUse,
  resolveCodexDefaultWorkspaceDir,
  readCodexConversationActiveTurn,
  setCodexConversationFastMode,
  setCodexConversationModel,
  setCodexConversationPermissions,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
  listCodexCliSessionsOnNode: async () => {
    throw new Error("Codex CLI node sessions require Gateway node runtime.");
  },
  resolveCodexCliSessionForBindingOnNode: async () => {
    throw new Error("Codex CLI node sessions require Gateway node runtime.");
  },
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
  persistentIdentity: Partial<Pick<CodexComputerUseConfig, "pluginName" | "mcpServerName">>;
  help?: boolean;
};

type ParsedCodexCliSessionsArgs = {
  host?: string;
  filter: string;
  limit?: number;
  help?: boolean;
};

type ParsedResumeArgs = {
  threadId?: string;
  host?: string;
  bindHere?: boolean;
  help?: boolean;
};

type ParsedDiagnosticsArgs =
  | { action: "request"; note: string }
  | { action: "confirm"; token: string }
  | { action: "cancel"; token: string }
  | { action: "usage" };

type CodexDiagnosticsCandidate = Omit<
  CodexDiagnosticsTarget,
  | "threadId"
  | "connectionScope"
  | "appServerRuntimeFingerprint"
  | "pendingSupervisionBranch"
  | "authProfileId"
>;

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
const CODEX_NATIVE_EXECUTION_SUBCOMMANDS = new Set([
  "bind",
  "resume",
  "steer",
  "model",
  "fast",
  "permissions",
  "compact",
  "review",
  "goal",
]);
const CODEX_NATIVE_CONTROL_SUBCOMMANDS = new Set([
  ...CODEX_NATIVE_EXECUTION_SUBCOMMANDS,
  "detach",
  "unbind",
  "stop",
]);

const {
  lastUploadByThread: lastCodexDiagnosticsUploadByThread,
  lastUploadByScope: lastCodexDiagnosticsUploadByScope,
  pendingConfirmations: pendingCodexDiagnosticsConfirmations,
  pendingTokensByScope: pendingCodexDiagnosticsConfirmationTokensByScope,
} = codexDiagnosticsFeedbackState;

/**
 * No-arg `/codex` picker. Codex owns the command tree; channels render the
 * portable command actions as inline controls when their transport can.
 */
function buildCodexSubcommandPickerReply(): PluginCommandResult {
  const verbs: CodexCommandPickerButton[] = [
    { label: "plugins", command: "/codex plugins menu" },
    { label: "permissions", command: "/codex permissions menu" },
    { label: "fast", command: "/codex fast menu" },
    { label: "computer-use", command: "/codex computer-use menu" },
    { label: "account", command: "/codex account" },
    { label: "help", command: "/codex help" },
  ];

  const fallbackTextLines = [
    "Codex commands. Pick a category or type:",
    "",
    ...verbs.map((v, i) => `  ${i + 1}. ${v.command}`),
    "",
    "Tap 'help' (or type /codex help) for the full list of typeable verbs",
    "including threads, mcp, binding, detach, skills, resume, bind, steer,",
    "model, diagnostics, compact, review, computer-use.",
    "",
    "Top-level shortcuts cover everyday operations: /status, /fast, /help, /stop, /models.",
  ];

  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex commands",
      "Pick a Codex subcommand:",
      verbs,
    ),
  };
}

/** Sub-picker for `/codex fast menu` (on / off / status). */
function buildCodexFastMenuReply(): PluginCommandResult {
  const modes = ["on", "off", "status"] as const;
  const buttons: CodexCommandPickerButton[] = [
    ...modes.map((mode) => ({ label: mode, command: `/codex fast ${mode}` })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    "Codex fast mode. Pick one or type /codex fast <mode>:",
    "",
    ...modes.map((m, i) => `  ${i + 1}. /codex fast ${m}`),
    "",
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex fast mode",
      "Pick a Codex fast mode:",
      buttons,
    ),
  };
}

/** Sub-picker for `/codex permissions menu` (default / yolo / status). */
function buildCodexPermissionsMenuReply(): PluginCommandResult {
  const modes = ["default", "yolo", "status"] as const;
  const buttons: CodexCommandPickerButton[] = [
    ...modes.map((mode) => ({ label: mode, command: `/codex permissions ${mode}` })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    "Codex permissions. Pick one or type /codex permissions <mode>:",
    "",
    ...modes.map((m, i) => `  ${i + 1}. /codex permissions ${m}`),
    "",
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex permissions",
      "Pick a Codex permissions mode:",
      buttons,
    ),
  };
}

/** Sub-picker for `/codex computer-use menu` (status / install). */
function buildCodexComputerUseMenuReply(): PluginCommandResult {
  const actions = ["status", "install"] as const;
  const buttons: CodexCommandPickerButton[] = [
    ...actions.map((action) => ({
      label: action,
      command: `/codex computer-use ${action}`,
    })),
    { label: "back", command: "/codex" },
  ];
  const fallbackTextLines = [
    "Codex computer-use. Pick one or type /codex computer-use <action>:",
    "",
    ...actions.map((a, i) => `  ${i + 1}. /codex computer-use ${a}`),
    "",
    "Flag-driven invocations (--source, --marketplace-path, --marketplace) are not in the picker. Type '/codex computer-use' or read '/codex help' for the full surface.",
    "",
    "Type '/codex' to go back to the main menu.",
  ];
  return {
    text: fallbackTextLines.join("\n"),
    presentation: buildCodexCommandPickerPresentation(
      "Codex computer-use",
      "Pick a Codex computer-use action:",
      buttons,
    ),
  };
}

/** Returns true when the rest-args are exactly `["menu"]` (case-insensitive). */
function isMenuVerb(rest: readonly string[]): boolean {
  return rest.length === 1 && (rest[0] ?? "").trim().toLowerCase() === "menu";
}

export async function handleCodexSubcommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps: CodexCommandDepsOverride },
): Promise<PluginCommandResult> {
  const deps: CodexCommandDeps = { ...defaultCodexCommandDeps, ...options.deps };
  const args = splitArgs(ctx.args);
  if (args.length === 0) {
    return buildCodexSubcommandPickerReply();
  }
  const [subcommand = "status", ...rest] = args;
  const normalized = subcommand.toLowerCase();
  if (normalized === "help") {
    return { text: buildHelp() };
  }
  if (
    CODEX_NATIVE_CONTROL_SUBCOMMANDS.has(normalized) &&
    !returnsBeforeNativeCodexExecution(normalized, rest) &&
    !isReadOnlyCodexGoalCommand(normalized, rest) &&
    !canMutateCodexHost(ctx)
  ) {
    return { text: CODEX_NATIVE_EXECUTION_AUTH_ERROR };
  }
  const sandboxBlock = resolveCodexNativeCommandSandboxBlock(ctx, normalized, rest);
  if (sandboxBlock) {
    return { text: sandboxBlock };
  }
  if (normalized === "plugins") {
    if (!deps.codexPluginsManagementIo) {
      return {
        text:
          "Codex sub-plugin management is not wired up (codexPluginsManagementIo dep is undefined). " +
          "Edit ~/.openclaw/openclaw.json or use `openclaw config patch` until the runtime exposes the IO.",
      };
    }
    return await handleCodexPluginsSubcommand(ctx, rest, deps.codexPluginsManagementIo);
  }
  if (normalized === "status") {
    if (rest.length > 0) {
      return { text: "Usage: /codex status" };
    }
    const { agentDir } = resolveCodexConversationControlScope(ctx);
    return {
      text: formatCodexStatus(
        await deps.readCodexStatusProbes(options.pluginConfig, ctx.config, agentDir),
      ),
    };
  }
  if (normalized === "models") {
    if (rest.length > 0) {
      return { text: "Usage: /codex models" };
    }
    const { agentDir } = resolveCodexConversationControlScope(ctx);
    return {
      text: formatModels(
        await deps.listCodexAppServerModels(
          deps.requestOptions(options.pluginConfig, 100, ctx.config, agentDir),
        ),
      ),
    };
  }
  if (normalized === "threads") {
    return { text: await buildThreads(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "goal") {
    return { text: await handleNativeGoal(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "sessions") {
    return { text: await buildCodexCliSessions(deps, rest) };
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
    return {
      text: await steerConversationTurn(deps, ctx, options.pluginConfig, rest.join(" ")),
    };
  }
  if (normalized === "model") {
    return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "fast") {
    if (isMenuVerb(rest)) {
      return buildCodexFastMenuReply();
    }
    return { text: await setConversationFastMode(deps, ctx, rest) };
  }
  if (normalized === "permissions") {
    if (isMenuVerb(rest)) {
      return buildCodexPermissionsMenuReply();
    }
    return { text: await setConversationPermissions(deps, ctx, rest) };
  }
  if (normalized === "compact") {
    return {
      text: await startThreadAction(deps, ctx, options.pluginConfig, "compact", rest),
    };
  }
  if (normalized === "review") {
    return {
      text: await startThreadAction(deps, ctx, options.pluginConfig, "review", rest),
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
    if (isMenuVerb(rest)) {
      return buildCodexComputerUseMenuReply();
    }
    return {
      text: await handleComputerUseCommand(deps, ctx, options.pluginConfig, rest),
    };
  }
  if (normalized === "mcp") {
    if (rest.length > 0) {
      return { text: "Usage: /codex mcp" };
    }
    const scope = await resolveCommandAppServerScope(deps, ctx, options.pluginConfig);
    return {
      text: formatList(
        await deps.codexControlRequest(
          options.pluginConfig,
          CODEX_CONTROL_METHODS.listMcpServers,
          { limit: 100 },
          { config: ctx.config, ...scope },
        ),
        "MCP servers",
      ),
    };
  }
  if (normalized === "skills") {
    if (rest.length > 0) {
      return { text: "Usage: /codex skills" };
    }
    const scope = await resolveCommandAppServerScope(deps, ctx, options.pluginConfig);
    return {
      text: formatSkills(
        await deps.codexControlRequest(
          options.pluginConfig,
          CODEX_CONTROL_METHODS.listSkills,
          {},
          { config: ctx.config, ...scope },
        ),
      ),
    };
  }
  if (normalized === "account") {
    if (rest.length > 0) {
      return { text: "Usage: /codex account" };
    }
    const scope = await resolveCommandAppServerScope(deps, ctx, options.pluginConfig);
    const requestScope = { config: ctx.config, ...scope };
    const [account, limits] = await Promise.all([
      deps.safeCodexControlRequest(
        options.pluginConfig,
        CODEX_CONTROL_METHODS.account,
        { refreshToken: false },
        requestScope,
      ),
      deps.safeCodexControlRequest(
        options.pluginConfig,
        CODEX_CONTROL_METHODS.rateLimits,
        undefined,
        requestScope,
      ),
    ]);
    return {
      text: formatAccount(
        account,
        limits,
        await readCodexAccountAuthOverview({
          ctx,
          agentDir: scope.agentDir,
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

function isCurrentSessionModelSelectionLocked(ctx: PluginCommandContext): boolean {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  // SessionEntry is the durable authority even when a native binding is absent or stale.
  // Never infer this lock from binding model metadata such as preserveNativeModel.
  const storePath = resolveStorePath(ctx.config.session?.store, { agentId: ctx.agentId });
  return isModelSelectionLocked(
    getSessionEntry({
      storePath,
      sessionKey,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    }),
  );
}

function resolveCodexNativeCommandSandboxBlock(
  ctx: PluginCommandContext,
  subcommand: string,
  args: readonly string[],
): string | undefined {
  if (isReadOnlyCodexGoalCommand(subcommand, args)) {
    return undefined;
  }
  if (!CODEX_NATIVE_EXECUTION_SUBCOMMANDS.has(subcommand)) {
    return undefined;
  }
  if (returnsBeforeNativeCodexExecution(subcommand, args)) {
    return undefined;
  }
  if (isCodexCliNodeResumeBind(subcommand, args)) {
    return resolveCodexNativeSandboxBlock({
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      surface: `/${["codex", subcommand].join(" ")}`,
    });
  }
  return resolveCodexNativeExecutionBlock({
    config: ctx.config,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    surface: `/${["codex", subcommand].join(" ")}`,
  });
}

function isReadOnlyCodexGoalCommand(subcommand: string, args: readonly string[]): boolean {
  if (subcommand !== "goal" || args.length > 1) {
    return false;
  }
  const action = (args[0] ?? "status").toLowerCase();
  return action === "status" || action === "get";
}

function returnsBeforeNativeCodexExecution(subcommand: string, args: readonly string[]): boolean {
  switch (subcommand) {
    case "bind":
      return parseBindArgs([...args]).help === true;
    case "resume":
      return returnsBeforeNativeCodexResume(args);
    case "steer":
      return args.join(" ").trim() === "";
    case "model":
      return args.length === 0 || args.length > 1;
    case "fast":
      return args.length === 0 || args.length > 1 || parseCodexFastModeArg(args[0]) === undefined;
    case "permissions":
      return (
        args.length === 0 || args.length > 1 || parseCodexPermissionsModeArg(args[0]) === undefined
      );
    case "compact":
    case "review":
    case "detach":
    case "unbind":
    case "stop":
      return args.length > 0;
    default:
      return false;
  }
}

function isCodexCliNodeResumeBind(subcommand: string, args: readonly string[]): boolean {
  if (subcommand !== "resume") {
    return false;
  }
  const parsed = parseResumeArgs([...args]);
  return Boolean(parsed.host && parsed.threadId && parsed.bindHere === true && !parsed.help);
}

function returnsBeforeNativeCodexResume(args: readonly string[]): boolean {
  const parsed = parseResumeArgs([...args]);
  const normalizedThreadId = parsed.threadId?.trim();
  if (parsed.help) {
    return true;
  }
  if (parsed.host) {
    return !normalizedThreadId || parsed.bindHere !== true;
  }
  return !normalizedThreadId || args.length !== 1;
}

async function handleComputerUseCommand(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
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
  if (Object.keys(parsed.persistentIdentity).length > 0) {
    return formatComputerUsePersistentIdentityMigration(parsed);
  }
  if (parsed.action === "install" && !canMutateCodexHost(ctx)) {
    return "Only an owner or operator.admin gateway client can configure Codex Computer Use.";
  }
  const { agentDir } = resolveCodexConversationControlScope(ctx);
  const params: CodexComputerUseSetupParams = {
    pluginConfig,
    config: ctx.config,
    agentDir,
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

async function detachConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
): Promise<string> {
  if (isCurrentSessionModelSelectionLocked(ctx)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  const current = await ctx.getCurrentConversationBinding();
  const data = readCodexConversationBindingData(current);
  if (data?.kind === "codex-app-server-session") {
    const binding = await deps.bindingStore.read(conversationBindingIdentity(data.bindingId));
    assertCodexBindingMayBeReplaced(binding, "detaching its conversation binding");
  }
  const detached = await ctx.detachConversationBinding();
  if (data?.kind === "codex-app-server-session") {
    await deps.bindingStore.mutate(conversationBindingIdentity(data.bindingId), { kind: "clear" });
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
  return [
    "Codex conversation binding:",
    `- Thread: ${formatCodexDisplayText(threadBinding?.threadId ?? "unknown")}`,
    `- Workspace: ${formatCodexDisplayText(data.workspaceDir)}`,
    `- Model: ${formatCodexDisplayText(threadBinding?.model ?? "default")}`,
    `- Fast: ${isCodexFastServiceTier(threadBinding?.serviceTier) ? "on" : "off"}`,
    `- Permissions: ${threadBinding ? formatPermissionsMode(threadBinding) : "default"}`,
    `- Active run: ${formatCodexDisplayText(active ? active.turnId : "none")}`,
    `- Binding: ${formatCodexDisplayText(data.bindingId)}`,
  ].join("\n");
}

async function buildThreads(
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

async function handleNativeGoal(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const action = (args[0] ?? "status").toLowerCase();
  const objective = args.slice(1).join(" ").trim();
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot manage the Codex goal because this command has no stable binding identity.";
  }
  const binding = await deps.bindingStore.read(target.identity);
  if (!binding?.threadId) {
    return "No Codex thread is attached to this OpenClaw session yet.";
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding.authProfileId,
    pluginConfig,
  });
  const goalRequestOptions: CodexControlRequestOptions = {
    agentDir: target.agentDir,
    authProfileId: connection.clientAuthProfileId,
    config: ctx.config,
    ...(connection.usesSupervisionConnection ? { startOptions: connection.appServer.start } : {}),
  };
  if (action === "status" || action === "get") {
    if (args.length > 1) {
      return "Usage: /codex goal [status]";
    }
    const response = await deps.codexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.getThreadGoal,
      { threadId: binding.threadId },
      goalRequestOptions,
    );
    return formatNativeGoal(response);
  }
  if (action === "clear") {
    if (args.length > 1) {
      return "Usage: /codex goal clear";
    }
    const response = await deps.codexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.clearThreadGoal,
      { threadId: binding.threadId },
      goalRequestOptions,
    );
    return isJsonObject(response) && response.cleared === true
      ? "Cleared the Codex goal."
      : "No Codex goal was active.";
  }
  const requestedStatus =
    action === "pause"
      ? "paused"
      : action === "resume"
        ? "active"
        : action === "block"
          ? "blocked"
          : action === "complete"
            ? "complete"
            : undefined;
  const isObjectiveUpdate = action === "set";
  if ((!requestedStatus && !isObjectiveUpdate) || (isObjectiveUpdate && !objective)) {
    return "Usage: /codex goal [status|set <objective>|pause|resume|block|complete|clear]";
  }
  if (requestedStatus && args.length > 1) {
    return `Usage: /codex goal ${action}`;
  }
  const response = await deps.codexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.setThreadGoal,
    {
      threadId: binding.threadId,
      ...(objective ? { objective } : {}),
      // Upstream thread/goal/set creates or partially updates the native goal;
      // omitted status and budget preserve Codex's canonical state.
      ...(requestedStatus ? { status: requestedStatus } : {}),
    },
    goalRequestOptions,
  );
  return formatNativeGoal(response);
}

function formatNativeGoal(response: JsonValue | undefined): string {
  const goal = isJsonObject(response) && isJsonObject(response.goal) ? response.goal : undefined;
  if (!goal) {
    return "No Codex goal is active.";
  }
  const objective = readString(goal, "objective") ?? "unknown";
  const status = readString(goal, "status") ?? "unknown";
  const tokensUsed = typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0;
  const tokenBudget = typeof goal.tokenBudget === "number" ? goal.tokenBudget : undefined;
  return [
    `Codex goal: ${formatCodexDisplayText(objective)}`,
    `- Status: ${formatCodexDisplayText(status)}`,
    `- Tokens: ${tokensUsed}${tokenBudget === undefined ? "" : ` / ${tokenBudget}`}`,
  ].join("\n");
}

async function buildCodexCliSessions(deps: CodexCommandDeps, args: string[]): Promise<string> {
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

async function resumeThread(
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
  return await deps.bindingStore.withLease(identity, async () => {
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
    const authProfileId = resolveCodexAppServerAuthProfileIdForAgent({
      authProfileId: currentBinding?.authProfileId,
      agentDir: scope.agentDir,
      config: ctx.config,
    });
    const response = assertCodexThreadResumeResponse(
      await deps.codexControlRequest(
        pluginConfig,
        CODEX_CONTROL_METHODS.resumeThread,
        {
          threadId: normalizedThreadId,
          excludeTurns: true,
        },
        {
          config: ctx.config,
          agentDir: scope.agentDir,
          authProfileId,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
        },
      ),
    );
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
    const bindingBeforeCommit = await deps.bindingStore.read(identity);
    assertCodexBindingMayBeReplaced(bindingBeforeCommit, "committing a different resumed thread");
    const committed = await deps.bindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: effectiveThreadId,
        cwd: resumedCwd,
        authProfileId,
        model: response.model,
        modelProvider,
        historyCoveredThrough: new Date().toISOString(),
      },
    });
    if (!committed) {
      throw new Error("Codex thread binding changed while attaching the resumed thread.");
    }
    return `Attached this OpenClaw session to Codex thread ${formatCodexDisplayText(
      effectiveThreadId,
    )}.`;
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

async function stopConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
): Promise<string> {
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot stop Codex because this command did not include a stable binding identity.";
  }
  return (
    await deps.stopCodexConversationTurn({
      identity: target.identity,
      bindingStore: deps.bindingStore,
      pluginConfig,
      agentDir: target.agentDir,
      config: ctx.config,
    })
  ).message;
}

async function steerConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  message: string,
): Promise<string> {
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot steer Codex because this command did not include a stable binding identity.";
  }
  return (
    await deps.steerCodexConversationTurn({
      identity: target.identity,
      bindingStore: deps.bindingStore,
      message,
      pluginConfig,
      agentDir: target.agentDir,
      config: ctx.config,
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
  const [model = ""] = args;
  const normalized = model.trim();
  if (normalized && isCurrentSessionModelSelectionLocked(ctx)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot set Codex model because this command did not include a stable binding identity.";
  }
  if (!normalized) {
    const binding = await deps.bindingStore.read(target.identity);
    return binding?.model
      ? `Codex model: ${formatCodexDisplayText(binding.model)}`
      : "Usage: /codex model <model>";
  }
  return await deps.setCodexConversationModel({
    identity: target.identity,
    bindingStore: deps.bindingStore,
    pluginConfig,
    model: normalized,
    agentDir: target.agentDir,
    config: ctx.config,
  });
}

async function setConversationFastMode(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex fast [on|off|status]";
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot set Codex fast mode because this command did not include a stable binding identity.";
  }
  const value = args[0];
  const parsed = parseCodexFastModeArg(value);
  if (value && parsed == null && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex fast [on|off|status]";
  }
  return await deps.setCodexConversationFastMode({
    identity: target.identity,
    bindingStore: deps.bindingStore,
    enabled: parsed,
  });
}

async function setConversationPermissions(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot set Codex permissions because this command did not include a stable binding identity.";
  }
  const value = args[0];
  const parsed = parseCodexPermissionsModeArg(value);
  if (value && !parsed && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  return await deps.setCodexConversationPermissions({
    identity: target.identity,
    bindingStore: deps.bindingStore,
    mode: parsed,
  });
}

type CodexConversationControlTarget = {
  identity: CodexAppServerBindingIdentity;
  agentId: string;
  agentDir: string;
  requestedAuthProfileId?: string;
};

async function resolveControlTarget(
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

async function resolveCommandAppServerScope(
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

function conversationBindingIdentity(bindingId: string): CodexAppServerBindingIdentity {
  return { kind: "conversation", bindingId };
}

function resolveCodexConversationControlScope(ctx: PluginCommandContext): {
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

function codexDiagnosticsTargetsMatch(
  expected: readonly CodexDiagnosticsTarget[],
  actual: readonly CodexDiagnosticsTarget[],
): boolean {
  const fingerprint = (target: CodexDiagnosticsTarget) =>
    JSON.stringify([
      bindingStoreKey(target.identity),
      target.threadId,
      target.connectionScope ?? null,
      target.pendingSupervisionBranch?.connectionFingerprint ??
        target.appServerRuntimeFingerprint ??
        null,
      target.authProfileId ?? null,
    ]);
  const expectedTargets = expected.map(fingerprint).toSorted();
  const actualTargets = actual.map(fingerprint).toSorted();
  return (
    expectedTargets.length === actualTargets.length &&
    expectedTargets.every((target, index) => target === actualTargets[index])
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
  return normalized ? truncateUtf16Safe(normalized, CODEX_DIAGNOSTICS_REASON_MAX_CHARS) : undefined;
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
  options: { includeThreadId?: boolean; cooldownScope?: string } = {},
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
    options.cooldownScope ?? readCodexDiagnosticsCooldownScope(ctx),
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
  cooldownScope?: string,
): void {
  pruneCodexDiagnosticsCooldowns(now);
  recordBoundedCodexDiagnosticsCooldown(
    lastCodexDiagnosticsUploadByScope,
    cooldownScope ?? readCodexDiagnosticsCooldownScope(ctx),
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
  const safe = truncateUtf16Safe(
    formatCodexTextForDisplay(error),
    CODEX_DIAGNOSTICS_ERROR_MAX_CHARS,
  );
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
  kind: "compact" | "review",
  args: string[],
): Promise<string> {
  const label = kind === "compact" ? "compaction" : "review";
  if (args.length > 0) {
    return `Usage: /codex ${label === "compaction" ? "compact" : label}`;
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return `Cannot start Codex ${label} because this command did not include a stable binding identity.`;
  }
  const binding = await deps.bindingStore.read(target.identity);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding.authProfileId,
    pluginConfig,
  });
  await deps.codexControlRequest(
    pluginConfig,
    kind === "compact" ? CODEX_CONTROL_METHODS.compact : CODEX_CONTROL_METHODS.review,
    kind === "review"
      ? { threadId: binding.threadId, target: { type: "uncommittedChanges" } }
      : { threadId: binding.threadId },
    {
      agentDir: target.agentDir,
      authProfileId: connection.clientAuthProfileId,
      config: ctx.config,
      ...(connection.usesSupervisionConnection ? { startOptions: connection.appServer.start } : {}),
    },
  );
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
    const arg = expectDefined(args[index], "current Codex bind argument");
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

function parseCodexCliSessionsArgs(args: string[]): ParsedCodexCliSessionsArgs {
  const parsed: ParsedCodexCliSessionsArgs = { filter: "" };
  const filter: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(args[index], "current Codex sessions argument");
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--host" || arg === "--node") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.host !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.host = value;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = readRequiredOptionValue(args, index);
      const parsedLimit = parseStrictPositiveInteger(value);
      if (parsedLimit === undefined) {
        parsed.help = true;
        continue;
      }
      parsed.limit = parsedLimit;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      parsed.help = true;
      continue;
    }
    filter.push(arg);
  }
  parsed.host = normalizeOptionalString(parsed.host);
  parsed.filter = filter.join(" ").trim();
  return parsed;
}

function parseResumeArgs(args: string[]): ParsedResumeArgs {
  const parsed: ParsedResumeArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = expectDefined(args[index], "current Codex resume argument");
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--host" || arg === "--node") {
      const value = readRequiredOptionValue(args, index);
      if (!value || parsed.host !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.host = value;
      index += 1;
      continue;
    }
    if (arg === "--bind") {
      const value = readRequiredOptionValue(args, index);
      if (value !== "here" || parsed.bindHere !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.bindHere = true;
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
  parsed.host = normalizeOptionalString(parsed.host);
  return parsed;
}

function parseComputerUseArgs(args: string[]): ParsedComputerUseArgs {
  const parsed: ParsedComputerUseArgs = {
    action: "status",
    overrides: {},
    hasOverrides: false,
    persistentIdentity: {},
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
    if (arg === "--plugin" || arg === "--server" || arg === "--mcp-server") {
      const value = readRequiredOptionValue(args, index);
      const configKey = arg === "--plugin" ? "pluginName" : "mcpServerName";
      if (!value || parsed.persistentIdentity[configKey] !== undefined) {
        parsed.help = true;
        continue;
      }
      parsed.persistentIdentity[configKey] = value.trim();
      index += 1;
      continue;
    }
    parsed.help = true;
  }
  parsed.overrides = normalizeComputerUseStringOverrides(parsed.overrides);
  parsed.hasOverrides = Object.values(parsed.overrides).some(Boolean);
  return parsed;
}

function formatComputerUsePersistentIdentityMigration(parsed: ParsedComputerUseArgs): string {
  const configPrefix = "plugins.entries.codex.config.computerUse";
  const settings = [
    parsed.persistentIdentity.pluginName
      ? `${configPrefix}.pluginName = ${JSON.stringify(parsed.persistentIdentity.pluginName)}`
      : undefined,
    parsed.persistentIdentity.mcpServerName
      ? `${configPrefix}.mcpServerName = ${JSON.stringify(parsed.persistentIdentity.mcpServerName)}`
      : undefined,
  ].filter((setting): setting is string => Boolean(setting));
  const retryArgs = [
    `/codex computer-use ${parsed.action}`,
    parsed.overrides.marketplaceSource
      ? `--source ${JSON.stringify(parsed.overrides.marketplaceSource)}`
      : undefined,
    parsed.overrides.marketplacePath
      ? `--marketplace-path ${JSON.stringify(parsed.overrides.marketplacePath)}`
      : undefined,
    parsed.overrides.marketplaceName
      ? `--marketplace ${JSON.stringify(parsed.overrides.marketplaceName)}`
      : undefined,
  ].filter((arg): arg is string => Boolean(arg));
  return [
    "One-off Computer Use plugin/server overrides are no longer supported.",
    `Set ${settings.join(" and ")} persistently, then rerun ${retryArgs.join(" ")}.`,
  ].join(" ");
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
  return normalized;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
