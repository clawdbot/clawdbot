// Minimal dotenv loader for gateway-dispatched CLI commands.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles } from "../infra/dotenv-global.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";

/** Load only the env files needed before dispatching a command through the gateway. */
export async function loadGatewayDispatchCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  const cwd = tryProcessCwd();
  if (cwd && fs.existsSync(path.join(cwd, ".env"))) {
    const { loadCliDotEnv } = await import("./dotenv.js");
    loadCliDotEnv({ quiet });
    return;
  }

  // Agent dispatch only needs trusted runtime env for gateway credentials.
  // Workspace .env still falls back to the full provider-aware loader above.
  loadGlobalRuntimeDotEnvFiles({
    quiet,
    stateEnvPath: path.join(resolveStateDir(process.env), ".env"),
  });
}
