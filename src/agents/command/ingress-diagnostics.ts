import { getRuntimeConfig } from "../../config/io.js";
import { isDiagnosticsEnabled, emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { estimateAggregateUsageCost } from "../../utils/usage-format.js";
import { hasBillableUsage, toDiagnosticUsage, type NormalizedUsage } from "../usage.js";
import type { AgentCommandIngressOpts } from "./types.js";

type AgentCommandResult = {
  meta?: {
    agentMeta?: {
      provider?: string;
      model?: string;
      sessionId?: string;
      usage?: NormalizedUsage;
      diagnosticUsage?: NormalizedUsage;
      lastCallUsage?: NormalizedUsage;
      contextTokens?: number;
      promptTokens?: number;
    };
    durationMs?: number;
  };
};

/** Resolve the channel label for model.usage diagnostics from ingress run options. */
function ingressDiagnosticChannel(opts: AgentCommandIngressOpts): string {
  return opts.runContext?.messageChannel ?? opts.messageChannel ?? opts.channel ?? "http";
}

/** Emit the ingress-only model usage diagnostic after a completed agent run. */
export function emitIngressModelUsageDiagnostic(
  result: AgentCommandResult,
  opts: AgentCommandIngressOpts,
  agentDir: string,
): void {
  const cfg = getRuntimeConfig();
  if (!isDiagnosticsEnabled(cfg)) {
    return;
  }
  const agentMeta = result.meta?.agentMeta;
  const usage = agentMeta?.diagnosticUsage ?? agentMeta?.usage;
  if (!agentMeta || !hasBillableUsage(usage)) {
    return;
  }

  const providerUsed = agentMeta.provider ?? "";
  const modelUsed = agentMeta.model ?? "";
  const costUsd = estimateAggregateUsageCost({
    usage,
    provider: providerUsed,
    model: modelUsed,
    config: cfg,
    agentDir,
  });

  emitTrustedDiagnosticEvent({
    type: "model.usage",
    sessionKey: opts.sessionKey,
    sessionId: agentMeta.sessionId,
    channel: ingressDiagnosticChannel(opts),
    agentId: opts.agentId,
    provider: providerUsed,
    model: modelUsed,
    usage: toDiagnosticUsage(usage),
    lastCallUsage: agentMeta.lastCallUsage,
    context: {
      limit: agentMeta.contextTokens,
      ...(agentMeta.promptTokens !== undefined ? { used: agentMeta.promptTokens } : {}),
    },
    costUsd,
    durationMs: result.meta?.durationMs,
  });
}
