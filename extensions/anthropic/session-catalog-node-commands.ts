import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeNodePtyResumeParams,
  runNodePtyCommand,
  validateClaudeSessionId,
} from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { isExactClaudeSessionCursor } from "./session-catalog-cursor.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  CLAUDE_TERMINAL_RESUME_COMMAND,
  isResumableClaudeSource,
} from "./session-catalog-shared.js";
import type { ClaudeSessionCatalogSession } from "./session-catalog-types.js";
import { listLocalClaudeSessionPage, readLocalClaudeTranscriptPage } from "./session-catalog.js";

const CLAUDE_SESSIONS_CAPABILITY = "claude-sessions";
const CLAUDE_NODE_LOOKUP_PAGE_LIMIT = 100;

// Nodes advertise the catalog commands only when this machine has a Claude
// Code session store; without it the gateway skips the node entirely.
function claudeProjectsAvailable(env: NodeJS.ProcessEnv): boolean {
  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  try {
    return statSync(path.join(homeDir, ".claude", "projects")).isDirectory();
  } catch {
    return false;
  }
}

function parseNodeParams(paramsJSON?: string | null): unknown {
  if (!paramsJSON) {
    return undefined;
  }
  try {
    return JSON.parse(paramsJSON) as unknown;
  } catch (error) {
    throw new Error("Claude session parameters must be valid JSON", { cause: error });
  }
}

async function requireLocalResumableClaudeSession(
  threadId: string,
): Promise<ClaudeSessionCatalogSession> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const page = await listLocalClaudeSessionPage({
      limit: CLAUDE_NODE_LOOKUP_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const record = page.sessions.find((candidate) => candidate.threadId === threadId);
    if (record) {
      if (isResumableClaudeSource(record.source)) {
        return record;
      }
      break;
    }
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || seenCursors.has(nextCursor)) {
      break;
    }
    if (!isExactClaudeSessionCursor(nextCursor)) {
      throw new Error("Claude session catalog returned an invalid cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("Claude session cannot be resumed in a terminal");
}

export function createClaudeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await listLocalClaudeSessionPage(parseNodeParams(paramsJSON))),
    },
    {
      command: CLAUDE_SESSION_READ_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        JSON.stringify(await readLocalClaudeTranscriptPage(parseNodeParams(paramsJSON))),
    },
    {
      command: CLAUDE_TERMINAL_RESUME_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      duplex: true,
      isAvailable: ({ env }) =>
        claudeProjectsAvailable(env) && Boolean(resolveClaudeTerminalExecutable(env)),
      handle: async (paramsJSON, io) => {
        if (!io) {
          throw new Error("Claude terminal command requires duplex transport");
        }
        const params = decodeNodePtyResumeParams(paramsJSON, validateClaudeSessionId);
        const record = await requireLocalResumableClaudeSession(params.threadId);
        const resolution = resolveClaudeTerminalExecutable();
        if (!resolution) {
          throw new Error("Claude CLI is unavailable");
        }
        return JSON.stringify(
          await runNodePtyCommand(
            {
              file: resolution.executable,
              args: ["--resume", params.threadId],
              cwd: record.cwd,
              ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
              cols: params.cols,
              rows: params.rows,
            },
            io,
          ),
        );
      },
    },
  ];
}

export function createClaudeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [
        CLAUDE_SESSIONS_LIST_COMMAND,
        CLAUDE_SESSION_READ_COMMAND,
        CLAUDE_CLI_NODE_RUN_COMMAND,
        CLAUDE_TERMINAL_RESUME_COMMAND,
      ],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) =>
        context.command === CLAUDE_TERMINAL_RESUME_COMMAND ? { ok: true } : context.invokeNode(),
    },
  ];
}
