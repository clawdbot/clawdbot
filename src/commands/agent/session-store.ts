import { setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { hasNonzeroUsage } from "../../agents/usage.js";
import type { MoltbotConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";

type RunResult = Awaited<
  ReturnType<(typeof import("../../agents/pi-embedded.js"))["runEmbeddedPiAgent"]>
>;

export async function updateSessionStoreAfterAgentRun(params: {
  cfg: MoltbotConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;

  const usage = result.meta.agentMeta?.usage;
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const contextTokens =
    params.contextTokensOverride ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

  const entry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: Date.now(),
  };
  const next: SessionEntry = {
    ...entry,
    sessionId,
    updatedAt: Date.now(),
    modelProvider: providerUsed,
    model: modelUsed,
    contextTokens,
  };
  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
    if (cliSessionId) setCliSessionId(next, providerUsed, cliSessionId);
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (hasNonzeroUsage(usage)) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const promptTokens = input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    next.inputTokens = input;
    next.outputTokens = output;
    next.totalTokens = promptTokens > 0 ? promptTokens : (usage.total ?? input);
  }
  sessionStore[sessionKey] = next;
  await updateSessionStore(storePath, (store) => {
    store[sessionKey] = next;
  });
}
