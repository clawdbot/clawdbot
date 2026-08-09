import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
/** Builds provider-usage snapshots from the Codex app-server account surface. */
import type { ProviderFetchUsageSnapshotContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ProviderUsageSnapshot } from "openclaw/plugin-sdk/provider-usage";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerUsageSnapshot } from "./rate-limits.js";
import { readCodexAppServerUsage } from "./request.js";

type CodexAppServerUsageRead = {
  rateLimits: unknown;
  accountEmail?: string;
};

type CodexAppServerUsageReader = (
  options: Parameters<typeof readCodexAppServerUsage>[0],
) => Promise<CodexAppServerUsageRead>;

/** Handles the synthetic usage credential for a Codex-backed OpenAI route. */
export async function fetchCodexAppServerUsageSnapshot(
  ctx: ProviderFetchUsageSnapshotContext,
  options: {
    pluginConfig?: unknown;
    readUsage?: CodexAppServerUsageReader;
  } = {},
): Promise<ProviderUsageSnapshot | null> {
  if (ctx.token !== CODEX_APP_SERVER_AUTH_MARKER) {
    return null;
  }
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const usage = await (options.readUsage ?? readCodexAppServerUsage)({
    timeoutMs: ctx.timeoutMs,
    agentDir: ctx.agentDir,
    ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
    config: ctx.config,
    startOptions: appServer.start,
  });
  const snapshot = buildCodexAppServerUsageSnapshot(usage.rateLimits);
  const accountEmail = ctx.email ?? usage.accountEmail;
  return accountEmail && !snapshot.error ? { ...snapshot, accountEmail } : snapshot;
}
