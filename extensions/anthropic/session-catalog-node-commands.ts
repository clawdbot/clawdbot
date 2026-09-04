import {
  decodeNodePtyResumeParams,
  decodeNodePtyStartParams,
  type OpenClawPluginNodeHostCommandIo,
  runNodePtyCommand,
  validateClaudeSessionId,
} from "openclaw/plugin-sdk/node-host";
import { isExactClaudeSessionCursor } from "./session-catalog-cursor.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";
import { isResumableClaudeSource } from "./session-catalog-shared.js";
import type { ClaudeSessionCatalogSession } from "./session-catalog-types.js";
import { listLocalClaudeSessionPage, readLocalClaudeTranscriptPage } from "./session-catalog.js";

const CLAUDE_NODE_LOOKUP_PAGE_LIMIT = 100;

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

export async function listClaudeSessions(paramsJSON?: string | null): Promise<string> {
  return JSON.stringify(await listLocalClaudeSessionPage(parseNodeParams(paramsJSON)));
}

export async function readClaudeSession(paramsJSON?: string | null): Promise<string> {
  return JSON.stringify(await readLocalClaudeTranscriptPage(parseNodeParams(paramsJSON)));
}

export async function resumeClaudeSession(
  paramsJSON: string | null | undefined,
  io: OpenClawPluginNodeHostCommandIo | undefined,
): Promise<string> {
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
}

export async function startClaudeSession(
  paramsJSON: string | null | undefined,
  io: OpenClawPluginNodeHostCommandIo | undefined,
): Promise<string> {
  if (!io) {
    throw new Error("Claude terminal command requires duplex transport");
  }
  const params = decodeNodePtyStartParams(paramsJSON);
  const resolution = resolveClaudeTerminalExecutable();
  if (!resolution) {
    throw new Error("Claude CLI is unavailable; install Claude Code on this node and reconnect");
  }
  return JSON.stringify(
    await runNodePtyCommand(
      {
        file: resolution.executable,
        args: params.initialMessage !== undefined ? ["--", params.initialMessage] : [],
        cwd: params.cwd,
        requiredCwd: true,
        ...(resolution.pathEnv ? { pathEnv: resolution.pathEnv } : {}),
        cols: params.cols,
        rows: params.rows,
      },
      io,
    ),
  );
}
