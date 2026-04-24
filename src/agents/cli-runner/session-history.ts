import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import {
  limitAgentHookHistoryMessages,
  MAX_AGENT_HOOK_HISTORY_MESSAGES,
} from "../harness/hook-history.js";

export const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CLI_SESSION_HISTORY_MESSAGES = MAX_AGENT_HOOK_HISTORY_MESSAGES;

function safeRealpathSync(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function isPathWithinBase(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveSafeCliSessionFile(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): { sessionFile: string; sessionsDir: string } {
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const pathOptions = resolveSessionFilePathOptions({
    agentId: sessionAgentId ?? defaultAgentId,
    storePath: params.config?.session?.store,
  });
  const sessionFile = resolveSessionFilePath(
    params.sessionId,
    { sessionFile: params.sessionFile },
    pathOptions,
  );
  return {
    sessionFile,
    sessionsDir: pathOptions?.sessionsDir ?? path.dirname(sessionFile),
  };
}

export function loadCliSessionHistoryMessages(params: {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): unknown[] {
  try {
    const { sessionFile, sessionsDir } = resolveSafeCliSessionFile(params);
    const entryStat = fs.lstatSync(sessionFile);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
      return [];
    }
    const realSessionsDir = safeRealpathSync(sessionsDir) ?? path.resolve(sessionsDir);
    const realSessionFile = safeRealpathSync(sessionFile);
    if (!realSessionFile || !isPathWithinBase(realSessionsDir, realSessionFile)) {
      return [];
    }
    const stat = fs.statSync(realSessionFile);
    if (!stat.isFile() || stat.size > MAX_CLI_SESSION_HISTORY_FILE_BYTES) {
      return [];
    }
    const entries = SessionManager.open(realSessionFile).getEntries();
    const history = entries.flatMap((entry) =>
      entry?.type === "message" ? [entry.message as unknown] : [],
    );
    return limitAgentHookHistoryMessages(history, MAX_CLI_SESSION_HISTORY_MESSAGES);
  } catch {
    return [];
  }
}
