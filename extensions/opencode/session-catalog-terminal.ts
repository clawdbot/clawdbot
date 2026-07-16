// OpenCode catalog terminal ownership: validated resume commands and terminal plans.
import {
  decodeNodePtyResumeParams,
  resolveNodeHostExecutable,
  runNodePtyCommand,
} from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogSession,
  SessionCatalogTerminalPlan,
} from "openclaw/plugin-sdk/session-catalog";
import {
  OPENCODE_LOCAL_SESSION_HOST_ID,
  OPENCODE_NODE_INVOKE_TIMEOUT_MS,
  OPENCODE_SESSIONS_CAPABILITY,
  OPENCODE_SESSIONS_LIST_COMMAND,
  OPENCODE_SESSION_CATALOG_MAX_PAGE_LIMIT,
  OPENCODE_SESSION_ID_PATTERN,
  OPENCODE_TERMINAL_RESUME_COMMAND,
} from "./session-catalog-shared.js";
import { listLocalOpenCodeSessionPage, type OpenCodeSessionPage } from "./session-catalog.js";

type OpenCodeTerminalDependencies = {
  parseNodeSessionPage: (value: unknown) => OpenCodeSessionPage;
  unwrapNodePayload: (value: unknown) => unknown;
};

function validateOpenCodeThreadId(value: unknown): string {
  if (typeof value !== "string" || !OPENCODE_SESSION_ID_PATTERN.test(value)) {
    throw new Error("INVALID_REQUEST: threadId is invalid");
  }
  return value;
}

async function requireLocalOpenCodeSession(threadId: string): Promise<SessionCatalogSession> {
  const page = await listLocalOpenCodeSessionPage({
    searchTerm: threadId,
    limit: OPENCODE_SESSION_CATALOG_MAX_PAGE_LIMIT,
  });
  const record = page.sessions.find((session) => session.threadId === threadId);
  if (!record) {
    throw new Error("OpenCode session is unavailable");
  }
  return record;
}

export function createOpenCodeTerminalNodeHostCommand(
  isAvailable: NonNullable<OpenClawPluginNodeHostCommand["isAvailable"]>,
): OpenClawPluginNodeHostCommand {
  return {
    command: OPENCODE_TERMINAL_RESUME_COMMAND,
    cap: OPENCODE_SESSIONS_CAPABILITY,
    dangerous: false,
    duplex: true,
    isAvailable,
    handle: async (paramsJSON, io) => {
      if (!io) {
        throw new Error("OpenCode terminal command requires duplex transport");
      }
      const params = decodeNodePtyResumeParams(paramsJSON, validateOpenCodeThreadId);
      const record = await requireLocalOpenCodeSession(params.threadId);
      const resolution = resolveNodeHostExecutable("opencode", {
        env: process.env,
        pathEnv: process.env.PATH ?? process.env.Path ?? "",
        strategy: "direct",
      });
      if (!resolution) {
        throw new Error("OpenCode CLI is unavailable");
      }
      return JSON.stringify(
        await runNodePtyCommand(
          {
            file: resolution.executable,
            args: ["--session", params.threadId],
            cwd: record.cwd,
            cols: params.cols,
            rows: params.rows,
          },
          io,
        ),
      );
    },
  };
}

async function resolveNodeOpenCodeSession(
  params: {
    runtime: PluginRuntime;
    nodeId: string;
    threadId: string;
  } & OpenCodeTerminalDependencies,
): Promise<SessionCatalogSession> {
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: OPENCODE_SESSIONS_LIST_COMMAND,
    params: { searchTerm: params.threadId, limit: OPENCODE_SESSION_CATALOG_MAX_PAGE_LIMIT },
    timeoutMs: OPENCODE_NODE_INVOKE_TIMEOUT_MS,
    scopes: ["operator.write"],
  });
  const page = params.parseNodeSessionPage(params.unwrapNodePayload(raw));
  const record = page.sessions.find((session) => session.threadId === params.threadId);
  if (!record) {
    throw new Error("OpenCode session is unavailable");
  }
  return record;
}

export async function openOpenCodeCatalogTerminal(
  params: {
    runtime: PluginRuntime;
    hostId: string;
    threadId: string;
  } & OpenCodeTerminalDependencies,
): Promise<SessionCatalogTerminalPlan> {
  const title = `opencode --session ${params.threadId.slice(0, 12)}…`;
  if (params.hostId === OPENCODE_LOCAL_SESSION_HOST_ID) {
    const record = await requireLocalOpenCodeSession(params.threadId);
    const resolution = resolveNodeHostExecutable("opencode", {
      env: process.env,
      pathEnv: process.env.PATH ?? "",
      strategy: "fallback",
    });
    if (!resolution) {
      throw new Error("OpenCode CLI is unavailable");
    }
    return {
      kind: "local",
      argv: [resolution.executable, "--session", params.threadId],
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
      title,
    };
  }
  if (!params.hostId.startsWith("node:")) {
    throw new Error("hostId is invalid");
  }
  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find((candidate) => {
    const commands = candidate.invocableCommands ?? candidate.commands;
    return (
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      commands?.includes(OPENCODE_SESSIONS_LIST_COMMAND) === true &&
      commands.includes(OPENCODE_TERMINAL_RESUME_COMMAND)
    );
  });
  if (!node) {
    throw new Error("paired-node OpenCode terminal is unavailable");
  }
  const record = await resolveNodeOpenCodeSession({
    runtime: params.runtime,
    nodeId,
    threadId: params.threadId,
    parseNodeSessionPage: params.parseNodeSessionPage,
    unwrapNodePayload: params.unwrapNodePayload,
  });
  return {
    kind: "node",
    nodeId,
    command: OPENCODE_TERMINAL_RESUME_COMMAND,
    paramsJSON: JSON.stringify({ threadId: params.threadId }),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    title,
  };
}
