// CLI dotenv loader that preserves workspace overrides before global runtime fallbacks.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";

/** Load `.env` files for normal CLI commands without overriding existing process env. */
export function loadCliDotEnv(opts?: { loadGlobalEnv?: boolean; quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const cwd = tryProcessCwd();
  if (cwd) {
    loadWorkspaceDotEnvFile(path.join(cwd, ".env"), { quiet });
  }

  if (opts?.loadGlobalEnv === false) {
    return;
  }
  // Then load the global fallback set without overriding any env vars that
  // were already set or loaded from CWD. This includes the Ubuntu fresh-install
  // gateway.env compatibility path.
  loadGlobalRuntimeDotEnvFiles({
    quiet,
    stateEnvPath: path.join(resolveStateDir(process.env), ".env"),
  });
}
