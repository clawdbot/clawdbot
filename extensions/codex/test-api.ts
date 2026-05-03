import type {
  AnyAgentTool,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  type CodexAppServerRuntimeOptions,
  resolveCodexAppServerRuntimeOptions,
} from "./src/app-server/config.js";
import type { CodexPluginConfig } from "./src/app-server/config.js";
import { applyCodexDynamicToolProfile } from "./src/app-server/dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./src/app-server/dynamic-tools.js";
import type { CodexDynamicToolSpec, JsonObject } from "./src/app-server/protocol.js";
import {
  buildDeveloperInstructions,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
} from "./src/app-server/thread-lifecycle.js";

type CodexHarnessPromptSnapshot = {
  developerInstructions: string;
  threadStartParams: ReturnType<typeof buildThreadStartParams>;
  threadResumeParams: ReturnType<typeof buildThreadResumeParams>;
  turnStartParams: ReturnType<typeof buildTurnStartParams>;
};

export function resolveCodexPromptSnapshotAppServerOptions(
  pluginConfig?: unknown,
): CodexAppServerRuntimeOptions {
  return resolveCodexAppServerRuntimeOptions({
    pluginConfig,
    env: {},
  });
}

export function buildCodexHarnessPromptSnapshot(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  threadId: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  config?: JsonObject;
  promptText?: string;
}): CodexHarnessPromptSnapshot {
  const developerInstructions = buildDeveloperInstructions(params.attempt);
  return {
    developerInstructions,
    threadStartParams: buildThreadStartParams(params.attempt, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions,
      config: params.config,
    }),
    threadResumeParams: buildThreadResumeParams(params.attempt, {
      threadId: params.threadId,
      appServer: params.appServer,
      developerInstructions,
      config: params.config,
    }),
    turnStartParams: buildTurnStartParams(params.attempt, {
      threadId: params.threadId,
      cwd: params.cwd,
      appServer: params.appServer,
      promptText: params.promptText,
    }),
  };
}

export function createCodexDynamicToolSpecsForPromptSnapshot(params: {
  tools: AnyAgentTool[];
  pluginConfig?: Pick<CodexPluginConfig, "codexDynamicToolsProfile" | "codexDynamicToolsExclude">;
}): CodexDynamicToolSpec[] {
  const profiledTools = applyCodexDynamicToolProfile(params.tools, params.pluginConfig ?? {});
  return createCodexDynamicToolBridge({
    tools: profiledTools,
    signal: new AbortController().signal,
  }).specs;
}
