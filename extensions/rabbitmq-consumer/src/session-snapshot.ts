import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { acquireSessionWriteLock, updateSessionStore } from "./session-snapshot.runtime-api.js";
import type { HistoryRecord } from "./types.js";

function validateDirectoryName(value: string): void {
  if (
    !/^[a-z0-9_-][a-z0-9._-]{0,127}$/iu.test(value) ||
    value.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    throw new Error("History session_id is not a safe session directory name");
  }
}

async function existingFile(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Call between serialized turns, before subagent.run. The new transcript starts
 * as an exact copy of the previous one: Pi entry ids, parent links and prompt
 * bytes stay unchanged. Only sessions.json switches; older files are untouched.
 */
export async function prepareHistorySessionSnapshot(params: {
  history: Pick<HistoryRecord, "id" | "sessionId" | "userId">;
  userId: string;
  sessionKey: string;
  agentId: string;
  config?: OpenClawConfig;
  sessions: PluginRuntime["agent"]["session"];
}): Promise<string> {
  const { history, sessions } = params;
  validateDirectoryName(history.sessionId);
  if (!Number.isSafeInteger(history.id) || history.id <= 0) {
    throw new Error("History message id must be a positive safe integer");
  }
  if (
    history.userId !== params.userId ||
    params.agentId !== `rabbitmq-${history.userId}` ||
    params.sessionKey !== `agent:${params.agentId}:rabbitmq:${history.userId}:${history.sessionId}`
  ) {
    throw new Error("History record does not match the requested agent session");
  }
  const storePath = sessions.resolveStorePath(params.config?.session?.store, {
    agentId: params.agentId,
  });
  const sessionsDir = path.dirname(storePath);
  await fs.mkdir(sessionsDir, { recursive: true });
  const root = await fs.realpath(sessionsDir);
  const directory = path.join(root, history.sessionId);
  await fs.mkdir(directory, { recursive: true });
  const directoryStat = await fs.lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("History session directory must not be a symbolic link");
  }
  const realDirectory = await fs.realpath(directory);
  if (path.dirname(realDirectory) !== root) {
    throw new Error("History session directory escapes the agent sessions directory");
  }
  const target = path.join(realDirectory, `${history.id}.jsonl`);
  const key = params.sessionKey.toLowerCase();
  return updateSessionStore(
    storePath,
    async (store) => {
      const previous = store[key];
      const sessionId = previous?.sessionId ?? randomUUID();
      const source = previous
        ? sessions.resolveSessionFilePath(sessionId, previous, {
            agentId: params.agentId,
            sessionsDir: root,
          })
        : undefined;
      const targetStat = await existingFile(target);
      if (
        targetStat &&
        (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink > 1)
      ) {
        throw new Error("History snapshot must be a regular, unlinked transcript file");
      }
      if (source && path.resolve(source) === target) {
        // A retry continues its own file; never rewind to a different snapshot.
        return target;
      }
      if (targetStat) {
        throw new Error("History snapshot already exists; refusing to overwrite it");
      }
      if (source) {
        const lock = await acquireSessionWriteLock({
          sessionFile: source,
          // Do not wait on a running turn while holding the session-store lock.
          timeoutMs: 1_000,
          allowReentrant: false,
        });
        try {
          const sourceStat = await existingFile(source);
          if (sourceStat) {
            if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink > 1) {
              throw new Error("Previous transcript must be a regular, unlinked file");
            }
            await fs.copyFile(source, target, constants.COPYFILE_EXCL);
            await fs.chmod(target, 0o600);
          }
        } finally {
          await lock.release();
        }
      }
      // For a new session leave the file absent. SessionManager will initialize
      // its own header and persist the first user/assistant messages normally.
      store[key] = { ...previous, sessionId, sessionFile: target, updatedAt: Date.now() };
      return target;
    },
    { skipMaintenance: true },
  );
}
