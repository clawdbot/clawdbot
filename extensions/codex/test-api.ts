/**
 * Test-only helpers for producing Codex app-server prompt snapshots and dynamic
 * tool specs without starting a live app-server.
 */
import type {
  AnyAgentTool,
  EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  type CodexAppServerRuntimeOptions,
  resolveCodexAppServerRuntimeOptions,
} from "./src/app-server/config.js";
import type { CodexPluginConfig } from "./src/app-server/config.js";
import { filterCodexDynamicTools } from "./src/app-server/dynamic-tool-profile.js";
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

/** Resolves deterministic app-server options for prompt snapshot tests. */
export function resolveCodexPromptSnapshotAppServerOptions(
  pluginConfig?: unknown,
): CodexAppServerRuntimeOptions {
  return resolveCodexAppServerRuntimeOptions({
    pluginConfig,
    env: {},
    requirementsToml: null,
  });
}

/** Builds thread/resume/turn prompt payload snapshots for a Codex harness attempt. */
export function buildCodexHarnessPromptSnapshot(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  threadId: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  config?: JsonObject;
  promptText?: string;
  developerInstructionAdditions?: string;
  turnScopedDeveloperInstructions?: string;
}): CodexHarnessPromptSnapshot {
  const developerInstructions = joinPresentSections(
    buildDeveloperInstructions(params.attempt, {
      dynamicTools: params.dynamicTools,
    }),
    params.developerInstructionAdditions,
  );
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
      turnScopedDeveloperInstructions: params.turnScopedDeveloperInstructions,
    }),
  };
}

function joinPresentSections(...sections: Array<string | undefined>): string {
  return sections.filter((section): section is string => Boolean(section?.trim())).join("\n\n");
}

/** Converts harness tools into Codex dynamic-tool specs for prompt snapshot tests. */
export function createCodexDynamicToolSpecsForPromptSnapshot(params: {
  tools: AnyAgentTool[];
  pluginConfig?: Pick<CodexPluginConfig, "codexDynamicToolsLoading" | "codexDynamicToolsExclude">;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolSpec[] {
  const filteredTools = filterCodexDynamicTools(params.tools, params.pluginConfig ?? {});
  return createCodexDynamicToolBridge({
    tools: filteredTools,
    signal: new AbortController().signal,
    loading: params.pluginConfig?.codexDynamicToolsLoading ?? "searchable",
    directToolNames: params.directToolNames,
  }).specs;
}
