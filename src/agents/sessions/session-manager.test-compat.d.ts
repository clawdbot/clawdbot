import type { SessionManager as SessionManagerInstance } from "./session-manager.js";

declare module "./session-manager.js" {
  interface SessionManager {
    getSessionDir(): string;
    getSessionFile(): string | undefined;
  }

  namespace SessionManager {
    function create(cwd: string, sessionDir?: string): SessionManagerInstance;
    function openFile(
      path: string,
      sessionDir?: string,
      cwdOverride?: string,
    ): SessionManagerInstance;
  }
}
