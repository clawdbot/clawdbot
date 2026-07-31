// Claude catalog terminal ownership: validated local and paired-node resume plans.
import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogTerminalPlan } from "openclaw/plugin-sdk/session-catalog";
import { CLAUDE_LOCAL_SESSION_HOST_ID } from "./session-catalog-adoption.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";
import {
  CLAUDE_SESSIONS_LIST_COMMAND,
  CLAUDE_TERMINAL_RESUME_COMMAND,
  ClaudeCatalogParamsError,
  isResumableClaudeSource,
} from "./session-catalog-shared.js";

type ClaudeTerminalDependencies = {
  listClaudeSessions: () => Promise<
    Array<{ threadId: string; source?: string; filePath: string; cwd?: string }>
  >;
  resolveNodeClaudeRecord: (params: {
    runtime: OpenClawPluginApi["runtime"];
    nodeId: string;
    threadId: string;
  }) => Promise<{ source?: string; cwd?: string }>;
};

export function isClaudeCliAvailable(pathEnv = process.env.PATH ?? ""): boolean {
  const env = { ...process.env, PATH: pathEnv };
  return resolveClaudeTerminalExecutable(env) !== undefined;
}

export function claudeNodeTerminalCapability(node: {
  connected?: boolean;
  commands?: string[];
  invocableCommands?: string[];
}): {
  canOpenTerminalClaude?: true;
} {
  const commands = node.invocableCommands ?? node.commands;
  return node.connected === true && commands?.includes(CLAUDE_TERMINAL_RESUME_COMMAND) === true
    ? { canOpenTerminalClaude: true }
    : {};
}

function isLocalClaudeResumable(host: { hostId: string }, source: string | undefined): boolean {
  return host.hostId === CLAUDE_LOCAL_SESSION_HOST_ID && isResumableClaudeSource(source);
}

function canOpenClaudeTerminalSession(
  host: { hostId: string; canOpenTerminalClaude?: boolean },
  source: string | undefined,
  localCliAvailable: boolean,
): boolean {
  return (
    isResumableClaudeSource(source) &&
    ((host.hostId === CLAUDE_LOCAL_SESSION_HOST_ID && localCliAvailable) ||
      host.canOpenTerminalClaude === true)
  );
}

export function terminalEligibility(
  host: { hostId: string; canOpenTerminalClaude?: boolean },
  source: string | undefined,
  localCliAvailable: boolean,
): { localResumable: boolean; canOpenTerminal: boolean } {
  return {
    localResumable: isLocalClaudeResumable(host, source),
    canOpenTerminal: canOpenClaudeTerminalSession(host, source, localCliAvailable),
  };
}

export async function openClaudeCatalogTerminal(
  params: {
    api: OpenClawPluginApi;
    hostId: string;
    threadId: string;
  } & ClaudeTerminalDependencies,
): Promise<SessionCatalogTerminalPlan> {
  const title = `claude --resume ${params.threadId.slice(0, 8)}…`;
  if (params.hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
    const record = (await params.listClaudeSessions()).find(
      (candidate) => candidate.threadId === params.threadId,
    );
    if (!record || !isResumableClaudeSource(record.source)) {
      throw new ClaudeCatalogParamsError("Claude session is unavailable");
    }
    const source = await fs.stat(record.filePath).catch(() => undefined);
    if (!source?.isFile()) {
      throw new ClaudeCatalogParamsError("Claude session transcript is unavailable");
    }
    const resolution = resolveClaudeTerminalExecutable();
    if (!resolution) {
      throw new ClaudeCatalogParamsError("Claude CLI is unavailable");
    }
    return {
      kind: "local",
      argv: [resolution.executable, "--resume", params.threadId],
      ...(record.cwd ? { cwd: record.cwd } : {}),
      ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
      title,
    };
  }
  if (!params.hostId.startsWith("node:")) {
    throw new ClaudeCatalogParamsError("hostId is invalid");
  }
  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.api.runtime.nodes.list()).nodes.find((candidate) => {
    const commands = candidate.invocableCommands ?? candidate.commands;
    return (
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      commands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) === true &&
      commands.includes(CLAUDE_TERMINAL_RESUME_COMMAND)
    );
  });
  if (!node) {
    throw new ClaudeCatalogParamsError("paired-node Claude terminal is unavailable");
  }
  const record = await params.resolveNodeClaudeRecord({
    runtime: params.api.runtime,
    nodeId,
    threadId: params.threadId,
  });
  if (!isResumableClaudeSource(record.source)) {
    throw new ClaudeCatalogParamsError("Claude session cannot be resumed in a terminal");
  }
  return {
    kind: "node",
    nodeId,
    command: CLAUDE_TERMINAL_RESUME_COMMAND,
    paramsJSON: JSON.stringify({ threadId: params.threadId }),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    title,
  };
}
