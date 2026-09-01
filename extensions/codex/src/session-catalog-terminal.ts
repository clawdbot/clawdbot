// Codex catalog terminal ownership: validated resume commands and terminal plans.
import { resolveAgentDir, resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { decodeNodePtyResumeParams } from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionCatalogTerminalPlan } from "openclaw/plugin-sdk/session-catalog";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config.js";
import type { CodexCatalogHome } from "./session-catalog-homes.js";
import {
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_CAPABILITY,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  isInteractiveThreadSource,
  MAX_ACTION_CATALOG_PAGES,
  NODE_INVOKE_TIMEOUT_MS,
  unwrapNodeInvokePayload,
} from "./session-catalog-parsing.js";
import { resolveNodeHostExecutable, runNodePtyCommand } from "./session-catalog-pty.runtime.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogPage,
  CodexSessionCatalogSession,
} from "./session-catalog-types.js";

export const CODEX_TERMINAL_RESUME_COMMAND = "codex.terminal.resume.v1";

export type CodexTerminalConfigSources = {
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawConfig | undefined;
};

function resolveCodexCatalogTerminalHome(
  sources: CodexTerminalConfigSources & { agentId?: string; source?: CodexCatalogHome },
): string {
  const runtimeConfig = sources.getRuntimeConfig();
  if (!runtimeConfig) {
    throw new Error("OpenClaw runtime config is unavailable");
  }
  const agentDir =
    sources.source?.agentDir ??
    (sources.agentId
      ? resolveAgentDir(runtimeConfig, sources.agentId)
      : resolveDefaultAgentDir(runtimeConfig));
  const startOptions =
    sources.source?.appServer.start ??
    resolveCodexSupervisionAppServerRuntimeOptions({
      pluginConfig: sources.getPluginConfig(),
    }).start;
  return resolveCodexAppServerLocalHomeDir(startOptions, agentDir);
}

export function resolveLocalCodexTerminalExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveLocalCodexTerminalResolution(env)?.executable;
}

function resolveLocalCodexTerminalResolution(env: NodeJS.ProcessEnv = process.env) {
  return resolveNodeHostExecutable("codex", {
    env,
    pathEnv: env.PATH ?? env.Path ?? "",
    strategy: "fallback",
  });
}

export function codexNodeTerminalCapability(node: {
  connected?: boolean;
  commands?: string[];
  invocableCommands?: string[];
}): { canOpenTerminalCodex?: true } {
  const commands = node.invocableCommands ?? node.commands;
  return node.connected === true && commands?.includes(CODEX_TERMINAL_RESUME_COMMAND) === true
    ? { canOpenTerminalCodex: true }
    : {};
}

export function createCodexTerminalNodeHostCommand(
  bindRequest: (paramsJSON?: string | null) => {
    agentId: string;
    control: CodexSessionCatalogControl;
    paramsJSON: string;
  },
  configSources: CodexTerminalConfigSources,
): OpenClawPluginNodeHostCommand {
  return {
    command: CODEX_TERMINAL_RESUME_COMMAND,
    cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
    dangerous: false,
    duplex: true,
    isAvailable: ({ env }) =>
      Boolean(
        resolveNodeHostExecutable("codex", {
          env,
          pathEnv: env.PATH ?? env.Path ?? "",
          strategy: "direct",
        }),
      ),
    handle: async (paramsJSON, io) => {
      if (!io) {
        throw new Error("Codex terminal command requires duplex transport");
      }
      const request = bindRequest(paramsJSON);
      const resume = decodeNodePtyResumeParams(request.paramsJSON, (value) => {
        if (
          typeof value !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
        ) {
          throw new CatalogParamsError("threadId must be a UUID");
        }
        return value;
      });
      const record = await request.control.requireEligibleThread(resume.threadId);
      const resolution = resolveNodeHostExecutable("codex", {
        env: process.env,
        pathEnv: process.env.PATH ?? process.env.Path ?? "",
        strategy: "direct",
      });
      if (!resolution) {
        throw new Error("Codex CLI is unavailable");
      }
      return JSON.stringify(
        await runNodePtyCommand(
          {
            file: resolution.executable,
            args: ["resume", resume.threadId],
            ...(record.cwd ? { cwd: record.cwd } : {}),
            env: {
              CODEX_HOME: resolveCodexCatalogTerminalHome({
                ...configSources,
                agentId: request.agentId,
              }),
            },
            cols: resume.cols,
            rows: resume.rows,
          },
          io,
        ),
      );
    },
  };
}

async function resolveNodeCatalogEligibleThread(params: {
  agentId: string;
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
  parseCatalogPage: (value: unknown) => CodexSessionCatalogPage;
}): Promise<CodexSessionCatalogSession> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
    const raw = await params.runtime.nodes.invoke({
      nodeId: params.nodeId,
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      params: {
        agentId: params.agentId,
        limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      },
      timeoutMs: NODE_INVOKE_TIMEOUT_MS,
      scopes: ["operator.write"],
    });
    const page = params.parseCatalogPage(unwrapNodeInvokePayload(raw));
    const record = page.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (record) {
      if (isInteractiveThreadSource(record.source)) {
        return record;
      }
      break;
    }
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new CatalogParamsError("Codex session is not a non-archived interactive Codex session");
}

export async function openCodexCatalogTerminal(
  params: {
    agentId: string;
    api: OpenClawPluginApi;
    control: CodexSessionCatalogControl;
    hostId: string;
    threadId: string;
    parseCatalogPage: (value: unknown) => CodexSessionCatalogPage;
    source?: CodexCatalogHome;
  } & CodexTerminalConfigSources,
): Promise<SessionCatalogTerminalPlan> {
  const title = `codex resume ${params.threadId.slice(0, 8)}…`;
  if (
    params.hostId === CODEX_LOCAL_SESSION_HOST_ID ||
    params.hostId.startsWith(`${CODEX_LOCAL_SESSION_HOST_ID}:`)
  ) {
    const record = await params.control.requireEligibleThread(params.threadId);
    const resolution = resolveLocalCodexTerminalResolution();
    // A managed app-server may exist without a local CLI. Fail closed so
    // terminal resume never targets a different machine or missing binary.
    if (!resolution) {
      throw new CatalogParamsError("Codex CLI is unavailable");
    }
    return {
      kind: "local",
      argv: [resolution.executable, "resume", params.threadId],
      ...(record.cwd ? { cwd: record.cwd } : {}),
      env: { CODEX_HOME: resolveCodexCatalogTerminalHome(params) },
      ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
      title,
    };
  }
  if (!params.hostId.startsWith("node:")) {
    throw new CatalogParamsError("hostId is invalid");
  }
  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.api.runtime.nodes.list()).nodes.find((candidate) => {
    const commands = candidate.invocableCommands ?? candidate.commands;
    return (
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      commands?.includes(CODEX_APP_SERVER_THREADS_LIST_COMMAND) === true &&
      commands.includes(CODEX_TERMINAL_RESUME_COMMAND)
    );
  });
  if (!node) {
    throw new CatalogParamsError("paired-node Codex terminal is unavailable");
  }
  const record = await resolveNodeCatalogEligibleThread({
    agentId: params.agentId,
    runtime: params.api.runtime,
    nodeId,
    threadId: params.threadId,
    parseCatalogPage: params.parseCatalogPage,
  });
  return {
    kind: "node",
    nodeId,
    command: CODEX_TERMINAL_RESUME_COMMAND,
    paramsJSON: JSON.stringify({ agentId: params.agentId, threadId: params.threadId }),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    title,
  };
}

export async function startCodexCatalogTerminal(
  params: {
    agentId: string;
    cwd: string;
    initialMessage?: string;
    nodeId?: string;
  } & CodexTerminalConfigSources,
): Promise<SessionCatalogTerminalPlan> {
  if (params.nodeId) {
    throw new CatalogParamsError(
      "Paired-node Codex terminal start is unavailable; omit hostId to start on the gateway host",
    );
  }
  const resolution = resolveLocalCodexTerminalResolution();
  if (!resolution) {
    throw new CatalogParamsError(
      "Codex CLI is unavailable; install Codex or add codex to PATH, then try again",
    );
  }
  return {
    kind: "local",
    argv: [
      resolution.executable,
      ...(params.initialMessage !== undefined ? ["--", params.initialMessage] : []),
    ],
    cwd: params.cwd,
    env: { CODEX_HOME: resolveCodexCatalogTerminalHome(params) },
    ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
    title: "codex",
  };
}
