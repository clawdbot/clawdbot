import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

export function startOrResumeThread(
  params: Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">,
) {
  return startOrResumeThreadImpl({ ...params, bindingStore: testCodexAppServerBindingStore });
}

export function threadStartResult(threadId = "thread-1"): Record<string, unknown> {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp",
      cliVersion: "0.147.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

export function threadResumeResult(threadId = "thread-existing"): Record<string, unknown> {
  return threadStartResult(threadId);
}

export function createAppServerOptions(): CodexAppServerRuntimeOptions {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  } as unknown as CodexAppServerRuntimeOptions;
}

export function createParams(
  sessionFile: string,
  workspaceDir: string,
  configOverrides?: EmbeddedRunAttemptParams["config"],
): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    config: configOverrides,
  } as unknown as EmbeddedRunAttemptParams;
}
