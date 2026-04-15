import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import type { CoreConfig, IrcProbe } from "./types.js";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probeIrc(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<IrcProbe> {
  const account = resolveIrcAccount({ cfg, accountId: opts?.accountId });
  const base: IrcProbe = {
    ok: false,
    host: account.host,
    port: account.port,
    tls: account.tls,
    nick: account.nick,
  };

  if (!account.configured) {
    return {
      ...base,
      error: "missing host or nick",
    };
  }

  const started = Date.now();
  try {
    const client = await connectIrcClient(
      buildIrcConnectOptions(account, {
        connectTimeoutMs: opts?.timeoutMs ?? 8000,
      }),
    );
    const elapsed = Date.now() - started;
    client.quit("probe");
    return {
      ...base,
      ok: true,
      latencyMs: elapsed,
    };
  } catch (err) {
    return {
      ...base,
      error: formatError(err),
    };
  }
}
