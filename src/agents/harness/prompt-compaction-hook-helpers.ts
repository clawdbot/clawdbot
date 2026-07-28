/**
 * Agent harness prompt and compaction hook helpers.
 *
 * Harness runtimes use this to run plugin hooks around prompt construction and
 * compaction while keeping hook failures non-fatal.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforePromptBuildResult } from "../../plugins/types.js";
import { joinPresentTextSegments } from "../../shared/text/join-segments.js";
import type { BootstrapContextRunKind } from "../bootstrap-mode.js";
import { wrapPluginSystemContextSection } from "../hook-system-context-boundary.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");

/** Prompt/developer-instruction pair after harness prompt-build hooks run. */
type AgentHarnessPromptBuildResult = {
  prompt: string;
  developerInstructions: string;
  /** Span within prompt containing the original prompt input. */
  promptInputRange?: { start: number; end: number };
};

/** Runs before-prompt hooks and returns the adjusted prompt fields. */
export async function resolveAgentHarnessBeforePromptBuildResult(params: {
  prompt: string;
  developerInstructions: string;
  messages: unknown[];
  ctx: AgentHarnessHookContext;
  bootstrapContextRunKind?: BootstrapContextRunKind;
}): Promise<AgentHarnessPromptBuildResult> {
  const hookRunner = getGlobalHookRunner();
  // heartbeat_prompt_contribution fires only on heartbeat turns. Harness runtimes
  // (e.g. the Codex app-server) build the prompt through this helper rather than
  // the embedded runner's resolvePromptBuildHookResult, so the hook must run from
  // here too — otherwise it never fires on those runtimes.
  const isHeartbeatTurn =
    params.ctx.trigger === "heartbeat" && params.bootstrapContextRunKind !== "commitment-only";
  const hasHeartbeatContribution =
    isHeartbeatTurn && Boolean(hookRunner?.hasHooks("heartbeat_prompt_contribution"));
  if (!hasHeartbeatContribution && !hookRunner?.hasHooks("before_prompt_build")) {
    return {
      prompt: params.prompt,
      developerInstructions: params.developerInstructions,
      promptInputRange: { start: 0, end: params.prompt.length },
    };
  }
  const hookCtx = buildAgentHookContext(params.ctx);
  const promptEvent = {
    prompt: params.prompt,
    messages: params.messages,
  };

  // Match the embedded runner's lifecycle order: heartbeat contributions are
  // collected before prompt-build hooks so hook side effects stay deterministic.
  const heartbeatResult =
    hasHeartbeatContribution && hookRunner
      ? await hookRunner
          .runHeartbeatPromptContribution(
            {
              sessionKey: params.ctx.sessionKey,
              agentId: params.ctx.agentId,
              heartbeatName: "heartbeat",
            },
            hookCtx,
          )
          .catch((error: unknown) => {
            log.warn(`heartbeat_prompt_contribution hook failed: ${String(error)}`);
            return undefined;
          })
      : undefined;

  const promptBuildResult = hookRunner?.hasHooks("before_prompt_build")
    ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error: unknown) => {
        log.warn(`before_prompt_build hook failed: ${String(error)}`);
        return undefined;
      })
    : undefined;
  const systemPrompt = resolvePromptBuildSystemPrompt({
    developerInstructions: params.developerInstructions,
    promptBuildResult,
  });
  const promptPrefix = joinPresentTextSegments([
    heartbeatResult?.prependContext,
    promptBuildResult?.prependContext,
  ]);
  const promptSuffix = joinPresentTextSegments([
    heartbeatResult?.appendContext,
    promptBuildResult?.appendContext,
  ]);
  const prompt =
    joinPresentTextSegments([promptPrefix, params.prompt, promptSuffix]) ?? params.prompt;
  const promptInputStart =
    params.prompt.length === 0
      ? (promptPrefix?.length ?? 0)
      : promptPrefix
        ? promptPrefix.length + 2
        : 0;
  return {
    prompt,
    developerInstructions:
      joinPresentTextSegments([
        wrapPluginSystemContextSection(promptBuildResult?.prependSystemContext),
        systemPrompt,
        wrapPluginSystemContextSection(promptBuildResult?.appendSystemContext),
      ]) ?? systemPrompt,
    promptInputRange: {
      start: promptInputStart,
      end: promptInputStart + params.prompt.length,
    },
  };
}

function resolvePromptBuildSystemPrompt(params: {
  developerInstructions: string;
  promptBuildResult?: PluginHookBeforePromptBuildResult;
}): string {
  if (typeof params.promptBuildResult?.systemPrompt === "string") {
    return params.promptBuildResult.systemPrompt;
  }
  return params.developerInstructions;
}

/** Runs best-effort before-compaction hooks for a harness session. */
export async function runAgentHarnessBeforeCompactionHook(params: {
  sessionFile: string;
  messages?: AgentMessage[];
  ctx: AgentHarnessHookContext;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_compaction")) {
    return;
  }
  try {
    await hookRunner.runBeforeCompaction(
      {
        messageCount: params.messages?.length ?? -1,
        ...(params.messages ? { messages: params.messages } : {}),
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`before_compaction hook failed: ${String(error)}`);
  }
}

/** Runs best-effort after-compaction hooks for a harness session. */
export async function runAgentHarnessAfterCompactionHook(params: {
  sessionFile: string;
  messages?: AgentMessage[];
  ctx: AgentHarnessHookContext;
  compactedCount: number;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("after_compaction")) {
    return;
  }
  try {
    await hookRunner.runAfterCompaction(
      {
        messageCount: params.messages?.length ?? -1,
        compactedCount: params.compactedCount,
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`after_compaction hook failed: ${String(error)}`);
  }
}
