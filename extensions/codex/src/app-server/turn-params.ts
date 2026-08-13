import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { GPT5_HEARTBEAT_PROMPT_OVERLAY as CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY } from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { codexSandboxPolicyForTurn, type CodexAppServerRuntimeOptions } from "./config.js";
import type {
  CodexSandboxPolicy,
  CodexTurnEnvironmentParams,
  CodexTurnStartParams,
} from "./protocol.js";
import { readCodexSupportedReasoningEfforts } from "./reasoning-effort.js";
import {
  CODEX_NATIVE_PERSONALITY_NONE,
  resolveCodexAppServerRequestModelSelection,
  resolveReasoningEffort,
} from "./thread-model-selection.js";
import { buildCodexUserInput } from "./user-input.js";

const CODEX_CURRENT_SENDER_FIELD_MAX_CHARS = 256;
const CODEX_OPENCLAW_TURN_CONTEXT_KEY = "openclaw_turn_context";
const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_UTF8_BYTES = 1_000;

function splitTextToUtf8ByteLimit(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return [text];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let low = cursor + 1;
    let high = Math.min(text.length, cursor + maxBytes);
    let best = cursor;
    while (low <= high) {
      const midpoint = Math.floor((low + high) / 2);
      if (Buffer.byteLength(text.slice(cursor, midpoint), "utf8") <= maxBytes) {
        best = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (
      best < text.length &&
      best > cursor &&
      text.charCodeAt(best - 1) >= 0xd800 &&
      text.charCodeAt(best - 1) <= 0xdbff &&
      text.charCodeAt(best) >= 0xdc00 &&
      text.charCodeAt(best) <= 0xdfff
    ) {
      best -= 1;
    }
    if (best <= cursor) {
      best = Math.min(text.length, cursor + 1);
    }
    chunks.push(text.slice(cursor, best));
    cursor = best;
  }
  return chunks;
}

function buildCodexOpenClawTurnContext(
  contextText: string | undefined,
): NonNullable<CodexTurnStartParams["additionalContext"]> {
  if (!contextText) {
    return {};
  }
  const chunks = splitTextToUtf8ByteLimit(
    contextText,
    CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_UTF8_BYTES,
  );
  const identity = createHash("sha256").update(contextText).digest("hex").slice(0, 16);
  return Object.fromEntries(
    chunks.map((value, index) => [
      `${CODEX_OPENCLAW_TURN_CONTEXT_KEY}_${String(index).padStart(6, "0")}_${identity}`,
      { kind: "untrusted" as const, value },
    ]),
  );
}

function buildCodexCurrentSenderContextValue(params: EmbeddedRunAttemptParams): string | undefined {
  const metadata = asOptionalRecord(
    asOptionalRecord(params.userTurnTranscriptRecorder?.message as unknown)?.["__openclaw"],
  );
  const recorded = [
    normalizeOptionalString(metadata?.["senderId"]),
    normalizeOptionalString(metadata?.["senderName"]),
    normalizeOptionalString(metadata?.["senderUsername"]),
  ] as const;
  const [id, name, username] = recorded.some(Boolean)
    ? recorded
    : [
        normalizeOptionalString(params.senderId),
        normalizeOptionalString(params.senderName),
        normalizeOptionalString(params.senderUsername),
      ];
  if (!id && !name && !username) {
    return undefined;
  }
  const bound = (value: string) => truncateUtf16Safe(value, CODEX_CURRENT_SENDER_FIELD_MAX_CHARS);
  return JSON.stringify({
    sender: {
      ...(id ? { id: bound(id) } : {}),
      ...(name ? { name: bound(name) } : {}),
      ...(username ? { username: bound(username) } : {}),
    },
  });
}

export function buildTurnStartParams(
  params: EmbeddedRunAttemptParams,
  options: {
    threadId: string;
    cwd: string;
    appServer: CodexAppServerRuntimeOptions;
    promptText?: string;
    additionalContextText?: string;
    explicitSkillSelections?: EmbeddedRunAttemptParams["explicitSkillSelections"];
    suppressedSkillNames?: string[];
    sandboxPolicy?: CodexSandboxPolicy;
    environmentSelection?: CodexTurnEnvironmentParams[];
    model?: string | null;
    modelProvider?: string | null;
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
    preserveNativeTurnSettings?: boolean;
    clearInheritedServiceTier?: boolean;
  },
): CodexTurnStartParams {
  const modelSelection = options.preserveNativeTurnSettings
    ? undefined
    : resolveCodexAppServerRequestModelSelection({
        model: options.model ?? params.modelId,
        modelProvider: options.modelProvider,
        authProfileId: params.authProfileId,
        authProfileStore: params.authProfileStore,
        agentDir: params.agentDir,
        config: params.config,
      });
  const useThreadPermissionProfile = options.appServer.networkProxy && !options.sandboxPolicy;
  const currentSenderContext =
    params.trigger === "user" ? buildCodexCurrentSenderContextValue(params) : undefined;
  // Untrusted context exposes authenticated attribution without promoting human-controlled labels.
  const additionalContext: NonNullable<CodexTurnStartParams["additionalContext"]> = {
    ...buildCodexOpenClawTurnContext(options.additionalContextText),
    ...(currentSenderContext
      ? { openclaw_current_sender: { kind: "untrusted" as const, value: currentSenderContext } }
      : {}),
  };
  return {
    threadId: options.threadId,
    input: buildCodexUserInput(
      options.promptText ?? params.prompt,
      params.images,
      options.explicitSkillSelections ?? params.explicitSkillSelections,
      options.preserveNativeTurnSettings !== true,
      options.suppressedSkillNames,
    ),
    ...(Object.keys(additionalContext).length > 0 ? { additionalContext } : {}),
    cwd: options.cwd,
    approvalPolicy: options.appServer.approvalPolicy,
    approvalsReviewer: options.appServer.approvalsReviewer,
    ...(useThreadPermissionProfile
      ? {}
      : {
          sandboxPolicy:
            options.sandboxPolicy ??
            codexSandboxPolicyForTurn(
              options.appServer.sandbox,
              options.cwd,
              options.appServer.start?.args,
            ),
        }),
    ...(modelSelection
      ? { model: modelSelection.model, personality: CODEX_NATIVE_PERSONALITY_NONE }
      : {}),
    // Codex distinguishes an omitted native default from explicitly clearing
    // an OpenClaw-owned priority override left on this exact warm session.
    ...(options.appServer.serviceTier !== undefined
      ? { serviceTier: options.appServer.serviceTier }
      : options.clearInheritedServiceTier
        ? { serviceTier: null }
        : {}),
    ...(modelSelection
      ? {
          effort: resolveReasoningEffort(
            params.thinkLevel,
            modelSelection.model,
            readCodexSupportedReasoningEfforts(params.model?.compat),
          ),
        }
      : {}),
    ...(options.environmentSelection ? { environments: options.environmentSelection } : {}),
    ...(modelSelection
      ? {
          collaborationMode: buildTurnCollaborationMode(params, {
            model: modelSelection.model,
            turnScopedDeveloperInstructions: options.turnScopedDeveloperInstructions,
            skillsCollaborationInstructions: options.skillsCollaborationInstructions,
            memoryCollaborationInstructions: options.memoryCollaborationInstructions,
          }),
        }
      : {}),
  };
}

type CodexTurnCollaborationMode = NonNullable<CodexTurnStartParams["collaborationMode"]>;

export function buildTurnCollaborationMode(
  params: EmbeddedRunAttemptParams,
  options: {
    model?: string;
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
  } = {},
): CodexTurnCollaborationMode {
  const model = options.model ?? params.modelId;
  return {
    mode: "default",
    settings: {
      model,
      reasoning_effort: resolveReasoningEffort(
        params.thinkLevel,
        model,
        readCodexSupportedReasoningEfforts(params.model?.compat),
      ),
      developer_instructions: buildTurnScopedCollaborationInstructions(params, options),
    },
  };
}

function buildTurnScopedCollaborationInstructions(
  params: EmbeddedRunAttemptParams,
  options: {
    turnScopedDeveloperInstructions?: string;
    skillsCollaborationInstructions?: string;
    memoryCollaborationInstructions?: string;
  } = {},
): string | null {
  const contextInstructions = joinPresentSections(
    options.turnScopedDeveloperInstructions,
    options.memoryCollaborationInstructions,
    options.skillsCollaborationInstructions,
  );
  if (params.trigger === "cron") {
    return joinPresentSections(buildCronCollaborationInstructions(), contextInstructions);
  }
  if (params.trigger === "heartbeat") {
    return joinPresentSections(buildHeartbeatCollaborationInstructions(), contextInstructions);
  }
  if (contextInstructions?.trim()) {
    return joinPresentSections(buildDefaultCollaborationInstructions(), contextInstructions);
  }
  return null;
}

function buildDefaultCollaborationInstructions(): string {
  // Codex only applies the built-in Default-mode preset when `developer_instructions`
  // is null. OpenClaw adds per-turn workspace instructions here, so preserve that
  // pinned Codex default behavior before appending the workspace overlay.
  return [
    "# Collaboration Mode: Default",
    "",
    "You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.",
    "",
    "Your active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.",
    "",
    "## request_user_input availability",
    "",
    "Use the `request_user_input` tool only when it is listed in the available tools for this turn.",
    "",
    "In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.",
  ].join("\n");
}

function buildCronCollaborationInstructions(): string {
  return [
    "This is an OpenClaw cron automation turn. Apply these instructions only to this scheduled job; ordinary chat turns should stay in Codex Default mode.",
    "Execute the cron payload directly. If it asks you to run an exact command, run that command before doing any investigation, planning, memory review, or workspace bootstrap.",
    "Use context already provided by the runtime, but do not spend time loading or re-reading workspace bootstrap, memory, or project-doc files before executing the cron payload. Inspect those files only if the payload asks for them or the command fails and they are needed to diagnose it.",
    "Keep output concise and automation-oriented. Prefer the final command result or a short failure summary over status narration.",
  ].join("\n\n");
}

function buildHeartbeatCollaborationInstructions(): string {
  return [
    "This is an OpenClaw heartbeat turn. Apply these instructions only to this heartbeat wake; ordinary chat turns should stay in Codex Default mode.",
    "When you are ready to end the heartbeat, prefer the structured `heartbeat_respond` tool so OpenClaw can record the wake outcome and notification decision. If `heartbeat_respond` is not already available and `tool_search` is available, search for `heartbeat_respond`, load it, then call it. Use `notify=false` when nothing should visibly interrupt the user.",
    CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY,
  ].join("\n\n");
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}
