import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseSessionEntries, SessionManager } from "../../agent-sessions.js";

const TEST_SESSION_MANAGER_COMPAT = Symbol.for("openclaw.testSessionManagerCompat");

function installFileSessionManagerCompat(params: {
  manager: SessionManager;
  sessionDir: string;
  target: () => string;
  initialize: boolean;
  rotateTarget?: (sessionId: string) => void;
}): SessionManager {
  const manager = params.manager as SessionManager & {
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

export function installSessionManagerFileCompat(
  SessionManagerClass: typeof SessionManager = SessionManager,
): void {
  const sessionManagerConstructor = SessionManagerClass as typeof SessionManager & {
    [TEST_SESSION_MANAGER_COMPAT]?: true;
    create?: (cwd: string, sessionDir?: string) => SessionManager;
  };
  if (sessionManagerConstructor[TEST_SESSION_MANAGER_COMPAT]) {
    return;
  }
  Object.assign(SessionManagerClass, {
    create(cwd: string, sessionDir?: string) {
      const manager = SessionManagerClass.inMemory(cwd);
      const resolvedSessionDir = sessionDir ?? cwd;
      return installFileSessionManagerCompat({
        manager,
        sessionDir: resolvedSessionDir,
        target: () => path.join(resolvedSessionDir, `${manager.getSessionId()}.jsonl`),
        initialize: true,
      });
    },
    openFile(target: string, sessionDir?: string, cwd?: string) {
      let activeTarget = target;
      const exists = fs.existsSync(target);
      const manager = exists
        ? SessionManagerClass.fromEntries(parseSessionEntries(fs.readFileSync(target, "utf8")), cwd)
        : SessionManagerClass.inMemory(cwd ?? sessionDir ?? process.cwd());
      return installFileSessionManagerCompat({
        manager,
        sessionDir: sessionDir ?? path.dirname(target),
        target: () => activeTarget,
        initialize: !exists,
        rotateTarget: (sessionId) => {
          activeTarget = path.join(sessionDir ?? path.dirname(target), `${sessionId}.jsonl`);
        },
      });
    },
  });
  sessionManagerConstructor[TEST_SESSION_MANAGER_COMPAT] = true;
}
