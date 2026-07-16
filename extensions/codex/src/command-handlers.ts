import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { listCodexAppServerModels } from "./app-server/models.js";
import { isJsonObject } from "./app-server/protocol.js";
import {
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
} from "./command-rpc.js";

export type CodexCommandDeps = {
  codexControlRequest: typeof codexControlRequest;
  listCodexAppServerModels: typeof listCodexAppServerModels;
  readCodexStatusProbes: typeof readCodexStatusProbes;
  readCodexAppServerBinding: typeof readCodexAppServerBinding;
  requestOptions: typeof requestOptions;
  safeCodexControlRequest: typeof safeCodexControlRequest;
  writeCodexAppServerBinding: typeof writeCodexAppServerBinding;
};

const defaultCodexCommandDeps: CodexCommandDeps = {
  codexControlRequest,
  listCodexAppServerModels,
  readCodexStatusProbes,
  readCodexAppServerBinding,
  requestOptions,
  safeCodexControlRequest,
  writeCodexAppServerBinding,
};

export async function handleCodexSubcommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps?: Partial<CodexCommandDeps> },
): Promise<{ text: string }> {
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
      deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.account, {}),
      deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.rateLimits, {}),
    ]);
    return { text: formatAccount(account, limits) };
  }
  return { text: `Unknown Codex command: ${subcommand}\n\n${buildHelp()}` };
}

async function buildThreads(
  deps: CodexCommandDeps,
  pluginConfig: unknown,
  filter: string,
): Promise<string> {
  const response = await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listThreads, {
    limit: 10,
    ...(filter.trim() ? { filter: filter.trim() } : {}),
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

async function startThreadAction(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  method: typeof CODEX_CONTROL_METHODS.compact | typeof CODEX_CONTROL_METHODS.review,
  label: string,
): Promise<string> {
  if (!ctx.sessionFile) {
    return `Cannot start Codex ${label} because this command did not include an OpenClaw session file.`;
  }
  const binding = await deps.readCodexAppServerBinding(ctx.sessionFile);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  await deps.codexControlRequest(pluginConfig, method, { threadId: binding.threadId });
  return `Started Codex ${label} for thread ${binding.threadId}.`;
}

function splitArgs(value: string | undefined): string[] {
  return (value ?? "").trim().split(/\s+/).filter(Boolean);
}
