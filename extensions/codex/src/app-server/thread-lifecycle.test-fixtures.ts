import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { createCodexTestModel } from "./test-support.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

type ThreadLifecycleTestHostCapability = {
  capabilities: EmbeddedRunAttemptParams["hostCapabilities"];
  close: () => void;
};

const activeHostCapabilities = new Set<ThreadLifecycleTestHostCapability>();

function createTrackedThreadLifecycleHostCapability(): ThreadLifecycleTestHostCapability {
  let active = true;
  const assertActive = () => {
    if (!active) {
      throw new Error("thread lifecycle test host capability is no longer active");
    }
  };
  const capabilities: EmbeddedRunAttemptParams["hostCapabilities"] = Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive,
    bindToolSurface: (tools) => {
      assertActive();
      return tools.map((tool) => {
        const execute = tool.execute;
        return {
          ...tool,
          execute: async (...args) => {
            assertActive();
            return await execute(...args);
          },
        };
      });
    },
    runBeforeToolCall: async (request) => {
      assertActive();
      return { blocked: false, params: request.params };
    },
    requestApproval: async () => {
      assertActive();
      return undefined;
    },
    waitForApproval: async () => {
      assertActive();
      return undefined;
    },
  });
  return {
    capabilities,
    close: () => {
      active = false;
    },
  };
}

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
  const host = createTrackedThreadLifecycleHostCapability();
  activeHostCapabilities.add(host);
  const authStorage = AuthStorage.inMemory();
  return {
    hostCapabilities: host.capabilities,
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: ModelRegistry.inMemory(authStorage),
    config: configOverrides,
  };
}

export function resetThreadLifecycleTestFixtures(): void {
  for (const host of activeHostCapabilities) {
    host.close();
  }
  activeHostCapabilities.clear();
}
