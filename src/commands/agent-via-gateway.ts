import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeMessageProvider } from "../utils/message-provider.js";
import { agentCommand } from "./agent.js";

type AgentGatewayResult = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  meta?: unknown;
};

type GatewayAgentResponse = {
  runId?: string;
  status?: string;
  summary?: string;
  result?: AgentGatewayResult;
};

export type AgentCliOpts = {
  message: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  provider?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
};

function resolveGatewaySessionKey(opts: {
  cfg: ReturnType<typeof loadConfig>;
  to?: string;
  sessionId?: string;
}): string | undefined {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = sessionCfg?.mainKey ?? "main";
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);

  const ctx = opts.to?.trim() ? ({ From: opts.to } as { From: string }) : null;
  let sessionKey: string | undefined = ctx
    ? resolveSessionKey(scope, ctx, mainKey)
    : undefined;

  if (
    opts.sessionId &&
    (!sessionKey || store[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const foundKey = Object.keys(store).find(
      (key) => store[key]?.sessionId === opts.sessionId,
    );
    if (foundKey) sessionKey = foundKey;
  }

  return sessionKey;
}

function parseTimeoutSeconds(opts: {
  cfg: ReturnType<typeof loadConfig>;
  timeout?: string;
}) {
  const raw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : (opts.cfg.agent?.timeoutSeconds ?? 600);
  if (Number.isNaN(raw) || raw <= 0) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  return raw;
}

function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const lines: string[] = [];
  if (payload.text) lines.push(payload.text.trimEnd());
  const mediaUrl =
    typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
      ? payload.mediaUrl.trim()
      : undefined;
  const media = payload.mediaUrls ?? (mediaUrl ? [mediaUrl] : []);
  for (const url of media) lines.push(`MEDIA:${url}`);
  return lines.join("\n").trimEnd();
}

export async function agentViaGatewayCommand(
  opts: AgentCliOpts,
  runtime: RuntimeEnv,
) {
  const body = (opts.message ?? "").trim();
  if (!body) throw new Error("Message (--message) is required");
  if (!opts.to && !opts.sessionId) {
    throw new Error("Pass --to <E.164> or --session-id to choose a session");
  }

  const cfg = loadConfig();
  const timeoutSeconds = parseTimeoutSeconds({ cfg, timeout: opts.timeout });
  const gatewayTimeoutMs = Math.max(10_000, (timeoutSeconds + 30) * 1000);

  const sessionKey = resolveGatewaySessionKey({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
  });

  const provider = normalizeMessageProvider(opts.provider) ?? "whatsapp";
  const idempotencyKey = opts.runId?.trim() || randomIdempotencyKey();

  const response = await withProgress(
    {
      label: "Waiting for agent reply…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway<GatewayAgentResponse>({
        method: "agent",
        params: {
          message: body,
          to: opts.to,
          sessionId: opts.sessionId,
          sessionKey,
          thinking: opts.thinking,
          deliver: Boolean(opts.deliver),
          provider,
          timeout: timeoutSeconds,
          lane: opts.lane,
          extraSystemPrompt: opts.extraSystemPrompt,
          idempotencyKey,
        },
        expectFinal: true,
        timeoutMs: gatewayTimeoutMs,
        clientName: "cli",
        mode: "cli",
      }),
  );

  if (opts.json) {
    runtime.log(JSON.stringify(response, null, 2));
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (payloads.length === 0) {
    runtime.log(
      response?.summary ? String(response.summary) : "No reply from agent.",
    );
    return response;
  }

  for (const payload of payloads) {
    const out = formatPayloadForLog(payload);
    if (out) runtime.log(out);
  }

  return response;
}

export async function agentCliCommand(
  opts: AgentCliOpts,
  runtime: RuntimeEnv,
  deps?: CliDeps,
) {
  if (opts.local === true) {
    return await agentCommand(opts, runtime, deps);
  }

  try {
    return await agentViaGatewayCommand(opts, runtime);
  } catch (err) {
    runtime.error?.(
      `Gateway agent failed; falling back to embedded: ${String(err)}`,
    );
    return await agentCommand(opts, runtime, deps);
  }
}
