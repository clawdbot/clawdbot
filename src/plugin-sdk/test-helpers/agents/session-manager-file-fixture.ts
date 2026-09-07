import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSessionEntries, SessionManager } from "../../agent-sessions.js";

type FileBackedSessionManagerForTest = SessionManager & {
  getSessionDir(): string;
  getSessionFile(): string;
};

type OpenFileBackedSessionManagerForTestOptions = {
  sessionId?: string;
  sessionDir?: string;
  cwd?: string;
  SessionManagerClass?: typeof SessionManager;
};

// Legacy JSONL tests need observable write-through files, but the production
// constructor must stay SQLite/in-memory only. Decorate each fixture instance.
function attachFilePersistence(params: {
  manager: SessionManager;
  sessionDir: string;
  target: () => string;
  initialize: boolean;
  rotateTarget?: (sessionId: string) => void;
}): FileBackedSessionManagerForTest {
  const manager = params.manager as FileBackedSessionManagerForTest & {
    persistRecord(entry: unknown): void;
    replacePersistedTranscript(): void;
  };
  const writeFullFile = () => {
    const target = params.target();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const entries = manager.getPersistedEntries();
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  };
  const originalNewSession = manager.newSession.bind(manager);
  const originalRemoveTrailingEntries = manager.removeTrailingEntries.bind(manager);
  Object.assign(manager, {
    getSessionDir: () => params.sessionDir,
    getSessionFile: () => params.target(),
    newSession(options?: Parameters<SessionManager["newSession"]>[0]) {
      const sessionId = options?.id ?? randomUUID();
      params.rotateTarget?.(sessionId);
      const result = originalNewSession({ ...options, id: sessionId });
      writeFullFile();
      return result;
    },
    removeTrailingEntries(...args: Parameters<SessionManager["removeTrailingEntries"]>) {
      const removed = originalRemoveTrailingEntries(...args);
      if (removed > 0) {
        writeFullFile();
      }
      return removed;
    },
    persistRecord(entry: unknown) {
      const target = params.target();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) {
        const contents = fs.readFileSync(target);
        if (contents.length > 0 && contents.at(-1) !== 0x0a) {
          fs.appendFileSync(target, "\n");
        }
      }
      fs.appendFileSync(target, `${JSON.stringify(entry)}\n`);
    },
    replacePersistedTranscript: writeFullFile,
  });
  if (params.initialize) {
    writeFullFile();
  }
  return manager;
}

export function createFileBackedSessionManagerForTest(
  cwd: string,
  sessionDir: string = cwd,
  SessionManagerClass: typeof SessionManager = SessionManager,
): FileBackedSessionManagerForTest {
  const manager = SessionManagerClass.inMemory(cwd);
  return attachFilePersistence({
    manager,
    sessionDir,
    target: () => path.join(sessionDir, `${manager.getSessionId()}.jsonl`),
    initialize: true,
  });
}

export function openFileBackedSessionManagerForTest(
  target: string,
  sessionDirOrOptions?: string | OpenFileBackedSessionManagerForTestOptions,
  legacyCwd?: string,
  legacySessionManagerClass: typeof SessionManager = SessionManager,
): FileBackedSessionManagerForTest {
  const options = typeof sessionDirOrOptions === "object" ? sessionDirOrOptions : undefined;
  const sessionId = options?.sessionId;
  const sessionDir =
    options?.sessionDir ??
    (typeof sessionDirOrOptions === "string" ? sessionDirOrOptions : undefined);
  const cwd = options?.cwd ?? legacyCwd;
  const SessionManagerClass = options?.SessionManagerClass ?? legacySessionManagerClass;
  let activeTarget = target;
  const resolvedSessionDir = sessionDir ?? path.dirname(target);
  const exists = fs.existsSync(target);
  const manager = exists
    ? SessionManagerClass.fromEntries(parseSessionEntries(fs.readFileSync(target, "utf8")), cwd)
    : SessionManagerClass.inMemory(cwd ?? sessionDir ?? process.cwd());
  if (sessionId !== undefined && manager.getSessionId() !== sessionId) {
    if (exists) {
      throw new Error(
        `Session fixture ${target} belongs to ${manager.getSessionId()}, not ${sessionId}`,
      );
    }
    manager.newSession({ id: sessionId });
  }
  return attachFilePersistence({
    manager,
    sessionDir: resolvedSessionDir,
    target: () => activeTarget,
    initialize: !exists,
    rotateTarget: (nextSessionId) => {
      activeTarget = path.join(resolvedSessionDir, `${nextSessionId}.jsonl`);
    },
  });
}
