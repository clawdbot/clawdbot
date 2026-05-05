import { randomUUID } from "node:crypto";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { listAgentIds } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { withProgress } from "../cli/progress.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway, isGatewayTransportError, randomIdempotencyKey } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { routeLogsToStderr } from "../logging/console.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { agentCommand } from "./agent.js";
import { buildExplicitSessionIdSessionKey, resolveSessionKeyForRequest } from "./agent/session.js";

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

const NO_GATEWAY_TIMEOUT_MS = 2_147_000_000;
const EMBEDDED_FALLBACK_META = {
  transport: "embedded",
  fallbackFrom: "gateway",
} as const;
const GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX = "gateway-fallback-";

type AgentCliOpts = {
  message: string;
  agent?: string;
  model?: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  channel?: string;
  replyTo?: string;
  replyChannel?: string;
  replyAccount?: string;
  bestEffortDeliver?: boolean;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
  local?: boolean;
};

function protectJsonStdout(opts: Pick<AgentCliOpts, "json">): void {
  if (opts.json === true) {
    routeLogsToStderr();
  }
}

function parseTimeoutSeconds(opts: { cfg: OpenClawConfig; timeout?: string }) {
  const raw =
    opts.timeout !== undefined
      ? Number.parseInt(opts.timeout, 10)
      : (opts.cfg.agents?.defaults?.timeoutSeconds ?? 600);
  if (Number.isNaN(raw) || raw < 0) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  return raw;
}

function formatPayloadForLog(payload: {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string | null;
}) {
  const parts = resolveSendableOutboundReplyParts({
    text: payload.text,
    mediaUrls: payload.mediaUrls,
    mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined,
  });
  const lines: string[] = [];
  if (parts.text) {
    lines.push(parts.text.trimEnd());
  }
  for (const url of parts.mediaUrls) {
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n").trimEnd();
}

function isGatewayAgentTimeoutError(err: unknown): boolean {
  if (isGatewayTransportError(err)) {
    return err.kind === "timeout";
  }
  return err instanceof Error && err.message.includes("gateway request timeout for agent");
}

function isGatewayAgentEmbeddedFallbackError(err: unknown): boolean {
  return isGatewayTransportError(err);
}

function createGatewayTimeoutFallbackSessionId(): string {
  return `${GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX}${randomUUID()}`;
}

function createGatewayTimeoutFallbackSession(agentId?: string): {
  sessionId: string;
  sessionKey: string;
} {
  const sessionId = createGatewayTimeoutFallbackSessionId();
  return {
    sessionId,
    sessionKey: buildExplicitSessionIdSessionKey({ sessionId, agentId }),
  };
}

async function agentViaGatewayCommand(opts: AgentCliOpts, runtime: RuntimeEnv) {
  protectJsonStdout(opts);
  const body = (opts.message ?? "").trim();
  if (!body) {
    throw new Error("Message (--message) is required");
  }
  if (!opts.to && !opts.sessionId && !opts.agent) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
  }

  const cfg = getRuntimeConfig();
  const agentIdRaw = opts.agent?.trim();
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentId)) {
      throw new Error(
        `Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const timeoutSeconds = parseTimeoutSeconds({ cfg, timeout: opts.timeout });
  const gatewayTimeoutMs =
    timeoutSeconds === 0
      ? NO_GATEWAY_TIMEOUT_MS // no timeout (timer-safe max)
      : Math.max(10_000, (timeoutSeconds + 30) * 1000);

  const sessionKey = resolveSessionKeyForRequest({
    cfg,
    agentId,
    to: opts.to,
    sessionId: opts.sessionId,
  }).sessionKey;

  const channel = normalizeMessageChannel(opts.channel);
  const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();

  const response: GatewayAgentResponse = await withProgress(
    {
      label: "Waiting for agent reply…",
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        method: "agent",
        params: {
          message: body,
          agentId,
          model: opts.model,
          to: opts.to,
          replyTo: opts.replyTo,
          sessionId: opts.sessionId,
          sessionKey,
          thinking: opts.thinking,
          deliver: Boolean(opts.deliver),
          channel,
          replyChannel: opts.replyChannel,
          replyAccountId: opts.replyAccount,
          bestEffortDeliver: opts.bestEffortDeliver,
          timeout: timeoutSeconds,
          lane: opts.lane,
          extraSystemPrompt: opts.extraSystemPrompt,
          idempotencyKey,
        },
        expectFinal: true,
        timeoutMs: gatewayTimeoutMs,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
  );

  if (opts.json) {
    writeRuntimeJson(runtime, response);
    return response;
  }

  const result = response?.result;
  const payloads = result?.payloads ?? [];

  if (payloads.length === 0) {
    if (response?.status !== "ok") {
      runtime.log(response?.summary ? response.summary : "No reply from agent.");
    }
    return response;
  }

  for (const payload of payloads) {
    const out = formatPayloadForLog(payload);
    if (out) {
      runtime.log(out);
    }
  }

  return response;
}

export async function agentCliCommand(opts: AgentCliOpts, runtime: RuntimeEnv, deps?: CliDeps) {
  protectJsonStdout(opts);
  const localOpts = {
    ...opts,
    agentId: opts.agent,
    replyAccountId: opts.replyAccount,
    cleanupBundleMcpOnRunEnd: true,
    cleanupCliLiveSessionOnRunEnd: true,
  };
  if (opts.local === true) {
    return await agentCommand(localOpts, runtime, deps);
  }

  try {
    return await agentViaGatewayCommand(opts, runtime);
  } catch (err) {
    if (isGatewayAgentTimeoutError(err)) {
      const fallbackSession = createGatewayTimeoutFallbackSession(opts.agent);
      runtime.error?.(
        `EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session ${fallbackSession.sessionId}: ${String(err)}`,
      );
      return await agentCommand(
        {
          ...localOpts,
          sessionId: fallbackSession.sessionId,
          sessionKey: fallbackSession.sessionKey,
          runId: fallbackSession.sessionId,
          resultMetaOverrides: {
            ...EMBEDDED_FALLBACK_META,
            fallbackReason: "gateway_timeout",
            fallbackSessionId: fallbackSession.sessionId,
            fallbackSessionKey: fallbackSession.sessionKey,
          },
        },
        runtime,
        deps,
      );
    }

    if (!isGatewayAgentEmbeddedFallbackError(err)) {
      throw err;
    }

    runtime.error?.(
      `EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: ${String(err)}`,
    );
    return await agentCommand(
      {
        ...localOpts,
        resultMetaOverrides: EMBEDDED_FALLBACK_META,
      },
      runtime,
      deps,
    );
  }
}
