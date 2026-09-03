import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { resolveTranscriptsConfig } from "./config.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsSummaryChangedError, type TranscriptsStore } from "./store.js";
import { summarizeTranscriptsWithModel } from "./summary-model.js";
import { summarizeTranscripts } from "./summary.js";

export async function readTranscriptSummary(params: {
  config: ReturnType<typeof resolveTranscriptsConfig>;
  cfg?: OpenClawConfig;
  store: TranscriptsStore;
  session: TranscriptSessionDescriptor;
}) {
  const utterances = await params.store.readUtterancesForSession(params.session, {
    maxUtterances: params.config.maxUtterances,
  });
  const agentId = params.session.metadata?.agentId;
  if (params.cfg) {
    try {
      const modeled = await summarizeTranscriptsWithModel({
        cfg: params.cfg,
        agentId:
          typeof agentId === "string" && agentId.trim()
            ? agentId
            : resolveDefaultAgentId(params.cfg),
        session: params.session,
        utterances,
      });
      if (modeled) {
        return modeled;
      }
    } catch {
      // Ownerless rows on a multi-agent host cannot select a model
      // (resolveDefaultAgentId throws); they still get notes.
    }
  }
  // Heuristic notes are the deterministic base; model inference is an enhancement
  // so an unavailable model never loses the captured meeting notes.
  return summarizeTranscripts({ session: params.session, utterances });
}

export async function persistTranscriptSummary(
  params: Parameters<typeof readTranscriptSummary>[0],
) {
  const revision = params.store.readSummaryInputRevision(params.session);
  if (revision === undefined) {
    throw new TranscriptsSummaryChangedError();
  }
  const summary = await readTranscriptSummary(params);
  const intendedSummaryPath = await params.store.writeSummary(summary, params.session, revision);
  return { summary, intendedSummaryPath };
}
