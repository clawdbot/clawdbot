import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  PluginHookBeforePromptBuildResult,
} from "../../plugins/types.js";
import { joinPresentTextSegments } from "../../shared/text/join-segments.js";

const log = createSubsystemLogger("agents/harness");

type AgentHarnessHookContext = {
  runId: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

export type AgentHarnessPromptBuildResult = {
  prompt: string;
  developerInstructions: string;
};

function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  return {
    runId: params.runId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
  };
}

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

  const promptBuildResult = hookRunner.hasHooks("before_prompt_build")
    ? await hookRunner.runBeforePromptBuild(promptEvent, hookCtx).catch((error) => {
        log.warn(`before_prompt_build hook failed: ${String(error)}`);
        return undefined;
      })
    : undefined;
  const legacyResult = hookRunner.hasHooks("before_agent_start")
    ? await hookRunner.runBeforeAgentStart(promptEvent, hookCtx).catch((error) => {
        log.warn(`before_agent_start hook (legacy prompt build path) failed: ${String(error)}`);
        return undefined;
      })
    : undefined;

  const systemPrompt = resolvePromptBuildSystemPrompt({
    developerInstructions: params.developerInstructions,
    promptBuildResult,
    legacyResult,
  });
  return {
    prompt:
      joinPresentTextSegments([
        promptBuildResult?.prependContext,
        legacyResult?.prependContext,
        params.prompt,
      ]) ?? params.prompt,
    developerInstructions:
      joinPresentTextSegments([
        promptBuildResult?.prependSystemContext,
        legacyResult?.prependSystemContext,
        systemPrompt,
        promptBuildResult?.appendSystemContext,
        legacyResult?.appendSystemContext,
      ]) ?? systemPrompt,
  };
}

function resolvePromptBuildSystemPrompt(params: {
  developerInstructions: string;
  promptBuildResult?: PluginHookBeforePromptBuildResult;
  legacyResult?: PluginHookBeforeAgentStartResult;
}): string {
  if (typeof params.promptBuildResult?.systemPrompt === "string") {
    return params.promptBuildResult.systemPrompt;
  }
  if (typeof params.legacyResult?.systemPrompt === "string") {
    return params.legacyResult.systemPrompt;
  }
  return params.developerInstructions;
}

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
