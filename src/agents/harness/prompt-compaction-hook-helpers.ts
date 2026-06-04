/**
 * Agent harness prompt and compaction hook helpers.
 *
 * Harness runtimes use this to run plugin hooks around prompt construction and
 * compaction while keeping hook failures non-fatal.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { joinPresentTextSegments } from "../../shared/text/join-segments.js";
import { wrapPluginSystemContextSection } from "../hook-system-context-boundary.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildAgentHookContext, type AgentHarnessHookContext } from "./hook-context.js";

const log = createSubsystemLogger("agents/harness");

/** Prompt/developer-instruction pair after harness prompt-build hooks run. */
export type AgentHarnessPromptBuildResult = {
  prompt: string;
  developerInstructions: string;
};

/** Runs before-prompt hooks and returns the adjusted prompt fields. */
export async function resolveAgentHarnessBeforePromptBuildResult(params: {
  prompt: string;
  developerInstructions: string;
  messages: unknown[];
  ctx: AgentHarnessHookContext;
}): Promise<AgentHarnessPromptBuildResult> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_prompt_build") && !hookRunner?.hasHooks("before_agent_start")) {
    return {
      prompt: params.prompt,
      developerInstructions: params.developerInstructions,
    };
  }
  const hookCtx = buildAgentHookContext(params.ctx);
  const promptEvent = {
    prompt: params.prompt,
    messages: params.messages,
  };

  // Support the newer before_prompt_build hook plus the deprecated
  // before_agent_start hook during the prompt-build migration window.
  const promptBuildResult = hookRunner.hasHooks("before_prompt_build")
    ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error: unknown) => {
        log.warn(`before_prompt_build hook failed: ${String(error)}`);
        return undefined;
      })
    : undefined;
  const beforeAgentStartResult = hookRunner.hasHooks("before_agent_start")
    ? await hookRunner.runBeforeAgentStart(promptEvent, hookCtx).catch((error: unknown) => {
        log.warn(`deprecated before_agent_start hook failed during prompt build: ${String(error)}`);
        return undefined;
      })
    : undefined;

  const systemPrompt = resolvePromptBuildSystemPrompt({
    developerInstructions: params.developerInstructions,
    promptBuildResult,
    beforeAgentStartResult,
  });
  return {
    prompt:
      joinPresentTextSegments([
        promptBuildResult?.prependContext,
        beforeAgentStartResult?.prependContext,
        params.prompt,
      ]) ?? params.prompt,
    developerInstructions:
      joinPresentTextSegments([
        wrapPluginSystemContextSection(promptBuildResult?.prependSystemContext),
        wrapPluginSystemContextSection(beforeAgentStartResult?.prependSystemContext),
        systemPrompt,
        wrapPluginSystemContextSection(promptBuildResult?.appendSystemContext),
        wrapPluginSystemContextSection(beforeAgentStartResult?.appendSystemContext),
      ]) ?? systemPrompt,
  };
}

function resolvePromptBuildSystemPrompt(params: {
  developerInstructions: string;
  promptBuildResult?: PluginHookBeforePromptBuildResult;
  beforeAgentStartResult?: PluginHookBeforeAgentStartResult;
}): string {
  if (typeof params.promptBuildResult?.systemPrompt === "string") {
    return params.promptBuildResult.systemPrompt;
  }
  if (typeof params.beforeAgentStartResult?.systemPrompt === "string") {
    return params.beforeAgentStartResult.systemPrompt;
  }
  return params.developerInstructions;
}

/** Runs best-effort before-compaction hooks for a harness session. */
export async function runAgentHarnessBeforeCompactionHook(params: {
  sessionFile: string;
  messages: AgentMessage[];
  ctx: AgentHarnessHookContext;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_compaction")) {
    return;
  }
  try {
    await hookRunner.runBeforeCompaction(
      {
        messageCount: params.messages.length,
        messages: params.messages,
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
  messages: AgentMessage[];
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
        messageCount: params.messages.length,
        compactedCount: params.compactedCount,
        sessionFile: params.sessionFile,
      },
      buildAgentHookContext(params.ctx),
    );
  } catch (error) {
    log.warn(`after_compaction hook failed: ${String(error)}`);
  }
}
