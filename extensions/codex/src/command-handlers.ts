// Codex plugin module implements command handlers behavior.
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { readCodexAccountAuthOverview } from "./command-account.js";
import { canMutateCodexHost, CODEX_NATIVE_EXECUTION_AUTH_ERROR } from "./command-authorization.js";
import { handleCodexDiagnosticsFeedback } from "./command-diagnostics.js";
import {
  buildHelp,
  formatAccount,
  formatCodexDisplayText,
  formatCodexStatus,
  formatList,
  formatModels,
  formatSkills,
} from "./command-formatters.js";
import {
  CODEX_NATIVE_CONTROL_SUBCOMMANDS,
  handleComputerUseCommand,
  handleNativeGoal,
  isReadOnlyCodexGoalCommand,
  resolveCodexNativeCommandSandboxBlock,
  returnsBeforeNativeCodexExecution,
  setConversationFastMode,
  setConversationModel,
  setConversationPermissions,
  startThreadAction,
  steerConversationTurn,
  stopConversationTurn,
} from "./command-handler-actions.js";
import {
  buildCodexComputerUseMenuReply,
  buildCodexFastMenuReply,
  buildCodexPermissionsMenuReply,
  buildCodexSubcommandPickerReply,
  isMenuVerb,
  splitArgs,
} from "./command-handler-args.js";
import {
  bindConversation,
  buildCodexCliSessions,
  buildThreads,
  describeConversationBinding,
  detachConversation,
  resumeThread,
} from "./command-handler-bindings.js";
import {
  CODEX_CONTROL_METHODS,
  resolveCodexCommandDeps,
  type CodexCommandDepsOverride,
} from "./command-handler-deps.js";
import {
  resolveCodexConversationControlScope,
  resolveCommandAppServerScope,
} from "./command-handler-scope.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";

export type { CodexCommandDepsOverride } from "./command-handler-deps.js";

export async function handleCodexSubcommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps: CodexCommandDepsOverride },
): Promise<PluginCommandResult> {
  const deps = resolveCodexCommandDeps(options.deps);
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
