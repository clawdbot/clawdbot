/**
 * Sessions compact command.
 *
 * Wraps the `sessions.compact` Gateway RPC behind `openclaw sessions compact <key>`
 * so wedged sessions have a documented, first-class recovery path. The command
 * propagates a non-zero exit whenever the gateway reports a failed compaction
 * (transport error or an `ok:false` payload) so automation never mistakes a
 * silent no-op for success.
 */
import { callGatewayCli, type GatewayRpcOpts } from "../cli/gateway-cli/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SessionsCompactCliOptions = {
  key: string;
  agent?: string;
  maxLines?: number;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionsCompactResult = {
  ok?: boolean;
  key?: string;
  compacted?: boolean;
  reason?: string;
  kept?: number;
  archived?: string;
  result?: {
    tokensBefore?: number;
    tokensAfter?: number;
    sessionId?: string;
    sessionFile?: string;
    // A backend can explicitly report an accepted asynchronous operation.
    details?: {
      backend?: string;
      threadId?: string;
      signal?: string;
      pending?: boolean;
      completed?: boolean;
    };
  };
};

function describeCompaction(result: SessionsCompactResult, fallbackKey: string): string {
  const sessionKey = result.key ?? fallbackKey;
  if (!result.compacted) {
    const details = result.result?.details;
    if (details?.pending === true) {
      return `Compaction started for session ${sessionKey} (pending; completion is reported asynchronously by the backend).`;
    }
    const reason = result.reason ? ` (${result.reason})` : "";
    return `No compaction needed for session ${sessionKey}${reason}.`;
  }
  const before = result.result?.tokensBefore;
  const after = result.result?.tokensAfter;
  let detail = "";
  if (typeof before === "number" && typeof after === "number") {
    detail = ` (${before} → ${after} tokens)`;
  } else if (typeof result.kept === "number") {
    detail = ` (kept ${result.kept} lines)`;
  }
  return `Compacted session ${sessionKey}${detail}.`;
}

/** Run `openclaw sessions compact <key>` against the running gateway. */
export async function sessionsCompactCommand(
  opts: SessionsCompactCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const rpcOpts: GatewayRpcOpts = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    // Compaction owns a configurable multi-stage server deadline. Keep an
    // explicit CLI override, but otherwise avoid an ambiguous client timeout.
    timeout: opts.timeout ?? null,
    json: opts.json,
  };
  const params = {
    key: opts.key,
    ...(opts.agent ? { agentId: opts.agent } : {}),
    ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}),
  };

  let result: SessionsCompactResult;
  try {
    result = (await callGatewayCli("sessions.compact", rpcOpts, params)) as SessionsCompactResult;
  } catch (err) {
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ok: false, key: opts.key, error: message });
    } else {
      runtime.error(`Compaction failed: ${message}`);
    }
    runtime.exit(1);
    return;
  }

  // Success is explicit. A malformed or version-skewed payload must not turn
  // into the same exit-0 message as a genuine no-op compaction.
  const failed = result?.ok !== true;

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    if (failed) {
      runtime.exit(1);
    }
    return;
  }

  if (failed) {
    const sessionKey = result?.key ?? opts.key;
    const reason = result?.reason ? `: ${result.reason}` : "";
    runtime.error(`Compaction failed for session ${sessionKey}${reason}.`);
    runtime.exit(1);
    return;
  }

  runtime.log(describeCompaction(result ?? {}, opts.key));
  if (result?.archived) {
    runtime.log(`Archived transcript: ${result.archived}`);
  }
}
