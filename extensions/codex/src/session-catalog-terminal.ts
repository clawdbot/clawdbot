// Codex catalog terminal ownership: validated resume commands and terminal plans.
import {
  decodeNodePtyResumeParams,
  resolveNodeHostExecutable,
  runNodePtyCommand,
} from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SessionCatalogTerminalPlan } from "openclaw/plugin-sdk/session-catalog";
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
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogPage,
  CodexSessionCatalogSession,
} from "./session-catalog-types.js";

export const CODEX_TERMINAL_RESUME_COMMAND = "codex.terminal.resume.v1";

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

export async function requireCatalogEligibleThread(
  control: CodexSessionCatalogControl,
  threadId: string,
): Promise<CodexSessionCatalogSession> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_ACTION_CATALOG_PAGES; pageIndex += 1) {
    const page = await control.listPage({
      limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const candidate = page.sessions.find((session) => session.threadId === threadId);
    if (candidate) {
      if (isInteractiveThreadSource(candidate.source)) {
        return candidate;
      }
      throw new CatalogParamsError("Codex session is not a non-archived interactive Codex session");
    }
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor) {
      throw new CatalogParamsError("Codex session is not a non-archived interactive Codex session");
    }
    if (seenCursors.has(nextCursor)) {
      throw new CatalogParamsError("Codex session eligibility could not be verified");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new CatalogParamsError("Codex session eligibility could not be verified");
}

export function createCodexTerminalNodeHostCommand(
  control: CodexSessionCatalogControl,
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
      const resume = decodeNodePtyResumeParams(paramsJSON, (value) => {
        if (
          typeof value !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
        ) {
          throw new CatalogParamsError("threadId must be a UUID");
        }
        return value;
      });
      const record = await requireCatalogEligibleThread(control, resume.threadId);
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
            cwd: record.cwd,
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

export async function openCodexCatalogTerminal(params: {
  api: OpenClawPluginApi;
  control: CodexSessionCatalogControl;
  hostId: string;
  threadId: string;
  parseCatalogPage: (value: unknown) => CodexSessionCatalogPage;
}): Promise<SessionCatalogTerminalPlan> {
  const title = `codex resume ${params.threadId.slice(0, 8)}…`;
  if (params.hostId === CODEX_LOCAL_SESSION_HOST_ID) {
    const record = await requireCatalogEligibleThread(params.control, params.threadId);
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
    runtime: params.api.runtime,
    nodeId,
    threadId: params.threadId,
    parseCatalogPage: params.parseCatalogPage,
  });
  return {
    kind: "node",
    nodeId,
    command: CODEX_TERMINAL_RESUME_COMMAND,
    paramsJSON: JSON.stringify({ threadId: params.threadId }),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    title,
  };
}
