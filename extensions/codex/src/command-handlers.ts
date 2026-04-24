import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import { listAllCodexAppServerModels } from "./app-server/models.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import {
  buildHelp,
  formatAccount,
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
) => Promise<JsonValue | undefined>;

type SafeCodexControlRequestFn = (
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams: JsonValue | undefined,
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
    return { text: formatCodexStatus(await deps.readCodexStatusProbes(options.pluginConfig)) };
  }
  if (normalized === "models") {
    return {
      text: formatModels(
        await deps.listCodexAppServerModels(deps.requestOptions(options.pluginConfig, 100)),
      ),
    };
  }
  if (normalized === "threads") {
    return { text: await buildThreads(deps, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "resume") {
    return { text: await resumeThread(deps, ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "bind") {
    return await bindConversation(deps, ctx, options.pluginConfig, rest);
  }
  if (normalized === "detach" || normalized === "unbind") {
    return { text: await detachConversation(deps, ctx) };
  }
  if (normalized === "binding") {
    return { text: await describeConversationBinding(deps, ctx) };
  }
  if (normalized === "stop") {
    return { text: await stopConversationTurn(deps, ctx, options.pluginConfig) };
  }
  if (normalized === "steer") {
    return { text: await steerConversationTurn(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "model") {
    return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "fast") {
    return { text: await setConversationFastMode(deps, ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "permissions") {
    return { text: await setConversationPermissions(deps, ctx, options.pluginConfig, rest[0]) };
  }
  if (normalized === "compact") {
    return {
      text: await startThreadAction(
        deps,
        ctx,
        options.pluginConfig,
        CODEX_CONTROL_METHODS.compact,
        "compaction",
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
      ),
    };
  }
  if (normalized === "mcp") {
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
    return {
      text: formatList(
        await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}),
        "Codex skills",
      ),
    };
  }
  if (normalized === "account") {
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
    return { text: formatAccount(account, limits) };
  }
  return { text: `Unknown Codex command: ${subcommand}\n\n${buildHelp()}` };
}

async function bindConversation(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<PluginCommandResult> {
  if (!ctx.sessionFile) {
    return {
      text: "Cannot bind Codex because this command did not include an OpenClaw session file.",
    };
  }
  const parsed = parseBindArgs(args);
  if (parsed.help) {
    return {
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    };
  }
  const workspaceDir = parsed.cwd ?? deps.resolveCodexDefaultWorkspaceDir(pluginConfig);
  const data = await deps.startCodexConversationThread({
    pluginConfig,
    sessionFile: ctx.sessionFile,
    workspaceDir,
    threadId: parsed.threadId,
    model: parsed.model,
    modelProvider: parsed.provider,
  });
  const binding = await deps.readCodexAppServerBinding(ctx.sessionFile);
  const threadId = binding?.threadId ?? parsed.threadId ?? "new thread";
  const summary = `Codex app-server thread ${threadId} in ${workspaceDir}`;
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
    return { text: `Bound this conversation to Codex thread ${threadId} in ${workspaceDir}.` };
  }
  if (request.status === "pending") {
    return request.reply;
  }
  await deps.clearCodexAppServerBinding(ctx.sessionFile);
  return { text: request.message };
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
    `- Thread: ${threadBinding?.threadId ?? "unknown"}`,
    `- Workspace: ${data.workspaceDir}`,
    `- Model: ${threadBinding?.model ?? "default"}`,
    `- Fast: ${threadBinding?.serviceTier === "fast" ? "on" : "off"}`,
    `- Permissions: ${threadBinding ? formatPermissionsMode(threadBinding) : "default"}`,
    `- Active run: ${active ? active.turnId : "none"}`,
    `- Session: ${data.sessionFile}`,
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
  threadId: string | undefined,
): Promise<string> {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
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
  return `Attached this OpenClaw session to Codex thread ${effectiveThreadId}.`;
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
  model: string,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex model because this command did not include an OpenClaw session file.";
  }
  const normalized = model.trim();
  if (!normalized) {
    const binding = await deps.readCodexAppServerBinding(sessionFile);
    return binding?.model ? `Codex model: ${binding.model}` : "Usage: /codex model <model>";
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
  value: string | undefined,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex fast mode because this command did not include an OpenClaw session file.";
  }
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
  value: string | undefined,
): Promise<string> {
  const sessionFile = await resolveControlSessionFile(ctx);
  if (!sessionFile) {
    return "Cannot set Codex permissions because this command did not include an OpenClaw session file.";
  }
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

async function startThreadAction(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  method: typeof CODEX_CONTROL_METHODS.compact | typeof CODEX_CONTROL_METHODS.review,
  label: string,
): Promise<string> {
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
  return `Started Codex ${label} for thread ${binding.threadId}.`;
}

function splitArgs(value: string | undefined): string[] {
  return (value ?? "").trim().split(/\s+/).filter(Boolean);
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
      parsed.cwd = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--model") {
      parsed.model = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--provider" || arg === "--model-provider") {
      parsed.provider = args[index + 1];
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

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
