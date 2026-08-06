// CLI dotenv loader that preserves workspace overrides before global runtime fallbacks.
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { resolveCliContainerTarget } from "./container-target.js";
import { resolveGatewayCatalogCommandPath } from "./gateway-run-argv.js";

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

/** Load only the dotenv scope an early CLI failure may consult for diagnostic formatting. */
export async function loadCliDotEnvForEarlyDiagnostic(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (resolveCliContainerTarget(argv, env)) {
    return;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.commandPath[0] === "agent" && invocation.commandPath[1] === "exec") {
    return;
  }
  if (invocation.primary === "agent" && !argv.includes("--local")) {
    const { loadGatewayDispatchCliDotEnv } = await import("./gateway-dispatch-dotenv.js");
    await loadGatewayDispatchCliDotEnv({ quiet: true });
    return;
  }
  const gatewayPath = resolveGatewayCatalogCommandPath(argv);
  const isGatewayRun =
    !invocation.hasHelpOrVersion &&
    (gatewayPath?.length === 1 || (gatewayPath?.length === 2 && gatewayPath[1] === "run"));
  loadCliDotEnv({ loadGlobalEnv: !isGatewayRun, quiet: true });
}
