import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import { autoReplyIfConfigured } from "../auto-reply/reply.js";
import { readEnv } from "../env.js";
import { danger } from "../globals.js";
import { logDebug, logInfo, logWarn } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { sleep, withWhatsAppPrefix } from "../utils.js";
import { createClient } from "./client.js";

type MonitorDeps = {
  autoReplyIfConfigured: typeof autoReplyIfConfigured;
  listRecentMessages: (
    lookbackMinutes: number,
    limit: number,
    clientOverride?: ReturnType<typeof createClient>,
  ) => Promise<ListedMessage[]>;
  readEnv: typeof readEnv;
  createClient: typeof createClient;
  sleep: typeof sleep;
};

const DEFAULT_POLL_INTERVAL_SECONDS = 5;

export type ListedMessage = {
  sid: string;
  status: string | null;
  direction: string | null;
  dateCreated: Date | undefined;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  errorCode: number | null;
  errorMessage: string | null;
};

type MonitorOptions = {
  client?: ReturnType<typeof createClient>;
  maxIterations?: number;
  deps?: MonitorDeps;
  runtime?: RuntimeEnv;
};

const defaultDeps: MonitorDeps = {
  autoReplyIfConfigured,
  listRecentMessages: () => Promise.resolve([]),
  readEnv,
  createClient,
  sleep,
};

// Poll Twilio for inbound messages and auto-reply when configured.
export async function monitorTwilio(
  pollSeconds: number,
  lookbackMinutes: number,
  opts?: MonitorOptions,
) {
  const deps = opts?.deps ?? defaultDeps;
  const runtime = opts?.runtime ?? defaultRuntime;
  const maxIterations = opts?.maxIterations ?? Infinity;
  let backoffMs = 1_000;

  const env = deps.readEnv(runtime);
  const from = withWhatsAppPrefix(env.whatsappFrom);
  const client = opts?.client ?? deps.createClient(env);
  logInfo(
    `📡 Monitoring inbound messages to ${from} (poll ${pollSeconds}s, lookback ${lookbackMinutes}m)`,
    runtime,
  );

  let lastSeenSid: string | undefined;
  let iterations = 0;
  while (iterations < maxIterations) {
    let messages: ListedMessage[] = [];
    try {
      messages =
        (await deps.listRecentMessages(lookbackMinutes, 50, client)) ?? [];
      backoffMs = 1_000; // reset after success
    } catch (err) {
      logWarn(
        `Twilio polling failed (will retry in ${backoffMs}ms): ${String(err)}`,
        runtime,
      );
      await deps.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10_000);
      continue;
    }
    const inboundOnly = messages.filter((m) => m.direction === "inbound");
    // Sort newest -> oldest without relying on external helpers (avoids test mocks clobbering imports).
    const newestFirst = [...inboundOnly].sort(
      (a, b) =>
        (b.dateCreated?.getTime() ?? 0) - (a.dateCreated?.getTime() ?? 0),
    );
    await handleMessages(messages, client, lastSeenSid, deps, runtime);
    lastSeenSid = newestFirst.length ? newestFirst[0].sid : lastSeenSid;
    iterations += 1;
    if (iterations >= maxIterations) break;
    await deps.sleep(
      Math.max(pollSeconds, DEFAULT_POLL_INTERVAL_SECONDS) * 1000,
    );
  }
}

async function handleMessages(
  messages: ListedMessage[],
  client: ReturnType<typeof createClient>,
  lastSeenSid: string | undefined,
  deps: MonitorDeps,
  runtime: RuntimeEnv,
) {
  for (const m of messages) {
    if (!m.sid) continue;
    if (lastSeenSid && m.sid === lastSeenSid) break; // stop at previously seen
    logDebug(`[${m.sid}] ${m.from ?? "?"} -> ${m.to ?? "?"}: ${m.body ?? ""}`);
    if (m.direction !== "inbound") continue;
    if (!m.from || !m.to) continue;
    try {
      await deps.autoReplyIfConfigured(
        client as unknown as import("./types.js").TwilioRequester & {
          messages: { create: (opts: unknown) => Promise<unknown> };
        },
        m as unknown as MessageInstance,
        undefined,
        runtime,
      );
    } catch (err) {
      runtime.error(danger(`Auto-reply failed: ${String(err)}`));
    }
  }
}
