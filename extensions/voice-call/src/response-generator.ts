/**
 * Voice call response generator - uses the embedded OpenClaw agent for tool support.
 * Routes voice responses through the same agent infrastructure as messaging.
 */

import crypto from "node:crypto";
import {
  applyModelOverrideToSessionEntry,
  ModelSelectionLockedError,
  resolvePersistedSessionRuntimeId,
} from "openclaw/plugin-sdk/model-session-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveVoiceCallSessionKey, type VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { resolveCallAgentId } from "./resolve-call-agent-id.js";
import { resolveVoiceResponseModel } from "./response-model.js";

type VoiceResponseParams = {
  /** Voice call config */
  voiceConfig: VoiceCallConfig;
  /** Core OpenClaw config */
  coreConfig: CoreConfig;
  /** Injected host agent runtime */
  agentRuntime: CoreAgentDeps;
  /** Call ID for session tracking */
  callId: string;
  /** Persisted call session key */
  sessionKey?: string;
  /** Caller's phone number */
  from: string;
  /** Agent frozen on the call record. */
  agentId?: string;
  /** Conversation transcript */
  transcript: Array<{ speaker: "user" | "bot"; text: string }>;
  /** Latest user message */
  userMessage: string;
  /** Delivers completed reply blocks while post-turn work is still running. */
  onEarlyText?: (text: string) => Promise<boolean>;
};

type VoiceResponseResult = {
  text: string | null;
  /** Whether the complete response was handed to the transport before compaction. */
  deliveredEarly: boolean;
  error?: string;
};

type VoiceResponsePayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
};

function readExplicitToolsAllow(value: unknown): string[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const allow = value.allow;
  if (!Array.isArray(allow)) {
    return undefined;
  }

  return allow.filter((entry): entry is string => typeof entry === "string");
}

function resolveVoiceAgentToolsAllow(config: CoreConfig, agentId: string): string[] | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const agent = list.find((entry) => isRecord(entry) && entry.id === agentId);
  if (!isRecord(agent)) {
    return undefined;
  }

  return readExplicitToolsAllow(isRecord(agent.tools) ? agent.tools : undefined);
}

const VOICE_SPOKEN_OUTPUT_CONTRACT = [
  "Output format requirements:",
  '- Return only valid JSON in this exact shape: {"spoken":"..."}',
  "- Do not include markdown, code fences, planning text, or extra keys.",
  '- Put exactly what should be spoken to the caller into "spoken".',
  '- If there is nothing to say, return {"spoken":""}.',
].join("\n");

function normalizeSpokenText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function tryParseSpokenJson(text: string): string | null {
  const candidates: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  candidates.push(trimmed);

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { spoken?: unknown };
      if (typeof parsed?.spoken !== "string") {
        continue;
      }
      return normalizeSpokenText(parsed.spoken) ?? "";
    } catch {
      // Continue trying other candidates.
    }
  }

  const inlineSpokenMatch = trimmed.match(/"spoken"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
  if (!inlineSpokenMatch) {
    return null;
  }

  try {
    const decoded = JSON.parse(`"${inlineSpokenMatch[1] ?? ""}"`) as string;
    return normalizeSpokenText(decoded) ?? "";
  } catch {
    return null;
  }
}

function isLikelyMetaReasoningParagraph(paragraph: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(paragraph);
  if (!lower) {
    return false;
  }

  if (lower.startsWith("thinking process")) {
    return true;
  }
  if (lower.startsWith("reasoning:") || lower.startsWith("analysis:")) {
    return true;
  }
  if (
    lower.startsWith("the user ") &&
    (lower.includes("i should") || lower.includes("i need to") || lower.includes("i will"))
  ) {
    return true;
  }
  if (
    lower.includes("this is a natural continuation of the conversation") ||
    lower.includes("keep the conversation flowing")
  ) {
    return true;
  }

  return false;
}

function sanitizePlainSpokenText(text: string): string | null {
  const withoutCodeFences = text.replace(/```[\s\S]*?```/g, " ").trim();
  if (!withoutCodeFences) {
    return null;
  }

  const paragraphs = normalizeStringEntries(withoutCodeFences.split(/\n\s*\n+/));

  while (paragraphs.length > 1) {
    const firstParagraph = paragraphs.at(0);
    if (!firstParagraph || !isLikelyMetaReasoningParagraph(firstParagraph)) {
      break;
    }
    paragraphs.shift();
  }

  return normalizeSpokenText(paragraphs.join(" "));
}

function extractSpokenTextFromPayloads(payloads: VoiceResponsePayload[]): string | null {
  const spokenSegments: string[] = [];

  for (const payload of payloads) {
    if (payload.isError || payload.isReasoning) {
      continue;
    }

    const rawText = payload.text?.trim() ?? "";
    if (!rawText) {
      continue;
    }

    const structured = tryParseSpokenJson(rawText);
    if (structured !== null) {
      if (structured.length > 0) {
        spokenSegments.push(structured);
      }
      continue;
    }

    const plain = sanitizePlainSpokenText(rawText);
    if (plain) {
      spokenSegments.push(plain);
    }
  }

  return spokenSegments.length > 0 ? spokenSegments.join(" ").trim() : null;
}

async function deliverEarlyText(
  callback: (text: string) => Promise<boolean>,
  text: string,
): Promise<boolean> {
  try {
    return await callback(text);
  } catch (error) {
    console.error("[voice-call] Early TTS delivery failed:", error);
    return false;
  }
}

function resolveVoiceSandboxSessionKey(agentId: string, sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return trimmed;
  }
  return `agent:${agentId}:${trimmed}`;
}

/**
 * Generate a voice response using the embedded OpenClaw agent with full tool support.
 * Uses the same agent infrastructure as messaging for consistent behavior.
 */
export async function generateVoiceResponse(
  params: VoiceResponseParams,
): Promise<VoiceResponseResult> {
  const {
    voiceConfig,
    callId,
    sessionKey,
    from,
    transcript,
    userMessage,
    coreConfig,
    agentRuntime,
    onEarlyText,
  } = params;

  if (!coreConfig) {
    return {
      text: null,
      deliveredEarly: false,
      error: "Core config unavailable for voice response",
    };
  }
  const cfg = coreConfig;
  const agentId = resolveCallAgentId({ agentId: params.agentId }, voiceConfig);

  const resolvedSessionKey = resolveVoiceCallSessionKey({
    config: { ...voiceConfig, agentId },
    callId,
    phone: from,
    explicitSessionKey: sessionKey,
    coreSession: coreConfig.session,
  });
  const toolsAllow = resolveVoiceAgentToolsAllow(cfg, agentId);

  // Resolve paths
  const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
  try {
    return await agentRuntime.session.runWithWorkAdmission(
      { storePath, sessionKey: resolvedSessionKey },
      async (abortSignal) => {
        const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
        const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);

        // Ensure workspace exists
        await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });

        // Load or create session entry
        const now = Date.now();
        const existingSessionEntry = agentRuntime.session.getSessionEntry({
          storePath,
          sessionKey: resolvedSessionKey,
        });

        // Resolve model from config
        const { provider, model } = resolveVoiceResponseModel({ voiceConfig, agentRuntime });

        let sessionEntry = existingSessionEntry;
        if (sessionEntry?.modelSelectionLocked === true && voiceConfig.responseModel) {
          throw new ModelSelectionLockedError();
        }
        if (!sessionEntry?.sessionId || voiceConfig.responseModel) {
          sessionEntry =
            (await agentRuntime.session.patchSessionEntry({
              storePath,
              sessionKey: resolvedSessionKey,
              replaceEntry: true,
              fallbackEntry: sessionEntry ?? {
                sessionId: crypto.randomUUID(),
                updatedAt: now,
              },
              update: (entry) => {
                const next = entry.sessionId
                  ? { ...entry }
                  : {
                      ...entry,
                      sessionId: crypto.randomUUID(),
                      updatedAt: now,
                    };
                if (voiceConfig.responseModel) {
                  applyModelOverrideToSessionEntry({
                    entry: next,
                    selection: { provider, model },
                    selectionSource: "auto",
                  });
                }
                return next;
              },
            })) ?? undefined;
        }
        if (!sessionEntry?.sessionId) {
          return {
            text: null,
            deliveredEarly: false,
            error: "Voice response session could not be initialized",
          };
        }
        const sessionId = sessionEntry.sessionId;
        const modelSelectionLocked = sessionEntry.modelSelectionLocked === true;
        const persistedRuntimeId = resolvePersistedSessionRuntimeId(sessionEntry);

        // Resolve thinking level
        const thinkLevel = agentRuntime.resolveThinkingDefault({ cfg, provider, model });

        // Resolve agent identity for personalized prompt
        const identity = agentRuntime.resolveAgentIdentity(cfg, agentId);
        const agentName = identity?.name?.trim() || "assistant";

        // Build system prompt with conversation history
        const basePrompt =
          voiceConfig.responseSystemPrompt ??
          `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;

        let extraSystemPrompt = basePrompt;
        if (transcript.length > 0) {
          const history = transcript
            .map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`)
            .join("\n");
          extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${history}`;
        }
        extraSystemPrompt = `${extraSystemPrompt}\n\n${VOICE_SPOKEN_OUTPUT_CONTRACT}`;

        // Resolve timeout
        const timeoutMs =
          voiceConfig.responseTimeoutMs ?? agentRuntime.resolveAgentTimeoutMs({ cfg });
        const runId = `voice:${callId}:${Date.now()}`;

        const blockReplyPayloads: VoiceResponsePayload[] = [];
        let latestToolBoundaryMessageIndex: number | undefined;
        let blockReplyBoundariesReliable = true;
        let deliveredEarly = false;
        let lastFlushedText: string | null = null;

        const result = await agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey: resolvedSessionKey,
          sessionTarget: {
            agentId,
            sessionId,
            sessionKey: resolvedSessionKey,
            storePath,
          },
          sandboxSessionKey: resolveVoiceSandboxSessionKey(agentId, resolvedSessionKey),
          agentId,
          messageProvider: "voice",
          workspaceDir,
          config: cfg,
          prompt: userMessage,
          provider,
          model,
          modelSelectionLocked,
          ...(persistedRuntimeId
            ? {
                agentHarnessId: persistedRuntimeId,
                agentHarnessRuntimeOverride: persistedRuntimeId,
              }
            : {}),
          thinkLevel,
          verboseLevel: "off",
          timeoutMs,
          runId,
          lane: "voice",
          extraSystemPrompt,
          agentDir,
          toolsAllow,
          abortSignal,
          blockReplyBreak: "text_end",
          onBlockReply: (payload, context) => {
            if (latestToolBoundaryMessageIndex !== undefined) {
              const messageIndex = context?.assistantMessageIndex;
              if (messageIndex === undefined) {
                blockReplyBoundariesReliable = false;
                return;
              }
              if (messageIndex <= latestToolBoundaryMessageIndex) {
                return;
              }
            }
            blockReplyPayloads.push(payload);
          },
          onBlockReplyFlush: async (context) => {
            if (context.reason === "tool_start") {
              // Deferred replies can arrive after this callback. Retain the
              // assistant index at the actual tool boundary to reject them.
              blockReplyPayloads.length = 0;
              latestToolBoundaryMessageIndex = context.assistantMessageIndex;
              blockReplyBoundariesReliable = true;
              return;
            }
            if (context.reason !== "pre_compaction") {
              return;
            }
            const pendingPayloads = blockReplyPayloads.splice(0);
            const boundariesReliable = blockReplyBoundariesReliable;
            latestToolBoundaryMessageIndex = undefined;
            blockReplyBoundariesReliable = true;
            if (!context.attemptAccepted) {
              return;
            }
            // Call-control APIs acknowledge a playback request, not playback
            // completion. Never let a later retry flush replace in-flight audio.
            if (deliveredEarly || !onEarlyText || !boundariesReliable) {
              return;
            }
            const text = extractSpokenTextFromPayloads(pendingPayloads);
            if (!text) {
              return;
            }
            lastFlushedText = text;
            deliveredEarly = await deliverEarlyText(onEarlyText, text);
          },
        });

        const text =
          extractSpokenTextFromPayloads((result.payloads ?? []) as VoiceResponsePayload[]) ??
          lastFlushedText ??
          extractSpokenTextFromPayloads(blockReplyPayloads);

        if (!text && result.meta?.aborted) {
          return { text: null, deliveredEarly: false, error: "Response generation was aborted" };
        }

        return { text, deliveredEarly };
      },
    );
  } catch (err) {
    if (err instanceof ModelSelectionLockedError) {
      return { text: null, deliveredEarly: false, error: err.message };
    }
    console.error(`[voice-call] Response generation failed:`, err);
    return { text: null, deliveredEarly: false, error: String(err) };
  }
}
