/**
 * Standalone extension relay daemon. Hosts the loopback relay the OpenClaw
 * Chrome extension dials, with no Gateway required — CDP clients (mcporter,
 * Playwright, chrome-devtools-mcp) attach through the same relay port. Spawned
 * on demand by the native messaging host, or run manually.
 */
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { runExtensionRelayDaemon } from "./src/browser/relay-daemon.js";

const DEFAULT_RELAY_PORT = 18_799;

/**
 * The standalone daemon is v2-only by default. Honor an explicit
 * `browser.extensionRelay.allowLegacyAuth=true` opt-in, but never fall back to
 * legacy on a read/parse failure — fail closed to the stricter mode. Read the
 * raw config value (not the resolved `?? true` default) so an unset key stays
 * v2-only rather than inheriting the gateway's permissive default.
 */
function resolveAllowLegacyAuth(): boolean {
  try {
    return getRuntimeConfig().browser?.extensionRelay?.allowLegacyAuth === true;
  } catch {
    return false;
  }
}

function resolvePortArgument(argv: string[]): number {
  const index = argv.indexOf("--port");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (raw === undefined) {
    return DEFAULT_RELAY_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`invalid --port value: ${raw}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const run = await runExtensionRelayDaemon({
    port: resolvePortArgument(process.argv.slice(2)),
    allowLegacyAuth: resolveAllowLegacyAuth(),
  });
  const stop = (): void => run.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const reason = await run.done;
  process.exitCode = reason === "no-credential" ? 1 : 0;
}

void main().catch((error: unknown) => {
  process.stderr.write(`openclaw relay daemon failed: ${String(error)}\n`);
  process.exitCode = 1;
});
