// Codex tests cover frozen workspace policy across supervised thread materialization.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import {
  sessionBindingIdentity,
  type CodexAppServerPendingSupervisionBranch,
} from "./session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  resetSharedCodexAppServerClientForTests,
} from "./shared-client.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

function createSupervisionAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    ...createAppServerOptions(),
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
  };
}

async function seedPendingSupervisionBinding(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  pending: CodexAppServerPendingSupervisionBranch;
}) {
  const appServer = createSupervisionAppServerOptions();
  const pending = {
    connectionFingerprint: buildCodexAppServerConnectionFingerprint(
      appServer,
      params.attempt.agentDir,
    ),
    ...params.pending,
  };
  const identity = sessionBindingIdentity({
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    agentId: params.attempt.agentId,
    config: params.attempt.config,
  });
  const written = await testCodexAppServerBindingStore.mutate(identity, {
    kind: "set",
    if: { kind: "absent" },
    binding: {
      threadId: pending.sourceThreadId,
      cwd: params.cwd,
      connectionScope: "supervision",
      supervisionSourceThreadId: pending.sourceThreadId,
      preserveNativeModel: true,
      pendingSupervisionBranch: pending,
      conversationSourceTransferComplete: true,
      historyCoveredThrough: new Date(0).toISOString(),
    },
  });
  if (!written) {
    throw new Error("failed to seed pending Codex supervision binding");
  }
  return identity;
}

function nativeThreadResult(threadId: string, model: string, modelProvider: string) {
  const response = threadStartResult(threadId);
  return {
    ...response,
    model,
    modelProvider,
    thread: { ...(response.thread as Record<string, unknown>), modelProvider },
  };
}

function sourceThread(params: {
  threadId: string;
  status?: "idle" | "active" | "notLoaded";
  turns?: Array<Record<string, unknown>>;
}) {
  return {
    ...(threadStartResult(params.threadId).thread as Record<string, unknown>),
    status: { type: params.status ?? "idle" },
    turns: params.turns ?? [],
  };
}

describe("Codex app-server supervised workspace policy", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-supervision-policy-"));
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    resetSharedCodexAppServerClientForTests();
    resetThreadLifecycleTestFixtures();
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("materializes a model-locked canonical branch without rediscovering frozen agent instructions", async () => {
    const sourceThreadId = "thread-source";
    const probeThreadId = "thread-probe";
    const finalThreadId = "thread-final";
    const lastTurnId = "turn-terminal";
    const agentWorkspaceDeveloperInstructions = "Follow the frozen supervised AGENTS guidance.";
    const workspaceDir = path.join(tempDir, "workspace");
    const attempt = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    const agentDir = path.join(tempDir, "agent");
    const codexHome = path.join(agentDir, "codex-home");
    const rolloutPath = path.join(codexHome, "sessions", `${finalThreadId}.jsonl`);
    attempt.agentDir = agentDir;
    attempt.modelId = "outer-global-default";
    const identity = await seedPendingSupervisionBinding({
      attempt,
      cwd: workspaceDir,
      pending: { sourceThreadId, lastTurnId },
    });
    const terminalSource = sourceThread({
      threadId: sourceThreadId,
      turns: [
        {
          id: lastTurnId,
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Visible question" }],
            },
            { id: "reasoning-1", type: "reasoning", text: "Private reasoning" },
            {
              id: "assistant-1",
              type: "agentMessage",
              text: "Visible answer",
              phase: "final_answer",
            },
            { id: "tool-1", type: "commandExecution", command: "secret-tool" },
          ],
        },
      ],
    });
    const dynamicTools = [
      {
        type: "function" as const,
        name: "message",
        description: "Send a message",
        inputSchema: { type: "object", properties: {} },
      },
    ];
    await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
    await fs.writeFile(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: finalThreadId, dynamic_tools: dynamicTools } })}\n`,
    );
    let harness!: ReturnType<typeof createFakeCodexAppServerClient>;
    const request = vi.fn(async (method: string, requestParams: unknown) => {
      if (method === "thread/read") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        return {
          thread:
            threadId === sourceThreadId
              ? terminalSource
              : {
                  ...sourceThread({ threadId: finalThreadId, status: "notLoaded" }),
                  path: rolloutPath,
                },
        };
      }
      if (method === "thread/fork") {
        return nativeThreadResult(probeThreadId, "native-effective", "native-provider");
      }
      if (method === "thread/unsubscribe") {
        const threadId = (requestParams as { threadId?: string }).threadId;
        if (!threadId) {
          throw new Error("thread/unsubscribe requires a thread id");
        }
        await harness.notify({
          method: "thread/status/changed",
          params: { threadId, status: { type: "notLoaded" } },
        });
        return {};
      }
      if (method === "thread/start" || method === "thread/resume") {
        const response = nativeThreadResult(finalThreadId, "native-effective", "native-provider");
        return { ...response, thread: { ...response.thread, path: rolloutPath } };
      }
      if (method === "thread/inject_items" || method === "thread/archive") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    harness = createFakeCodexAppServerClient(request);
    const runtimeIdentity = harness.client.getRuntimeIdentity();
    Object.assign(harness.client, {
      initialize: async () => undefined,
      getRuntimeIdentity: () => ({ ...runtimeIdentity, codexHome }),
      addTransportExitHandler: harness.client.addCloseHandler.bind(harness.client),
      setThreadSessionRequestGuard: () => undefined,
      close: () => harness.close(),
    });
    const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValueOnce(harness.client);
    let client: CodexAppServerClient;
    try {
      client = await getLeasedSharedCodexAppServerClient({
        startOptions: { ...createSupervisionAppServerOptions().start, command: process.execPath },
        authProfileId: null,
        agentDir,
        config: {},
      });
    } finally {
      start.mockRestore();
    }
    request.mockClear();
    const commonParams = {
      client,
      params: attempt,
      cwd: workspaceDir,
      dynamicTools,
      developerInstructions: agentWorkspaceDeveloperInstructions,
      agentWorkspaceDeveloperInstructions,
      nativeProjectDocsDisabledOnResume: true,
      environmentSelection: [{ environmentId: "local", cwd: workspaceDir }],
      shellEnvironment: { GH_TOKEN: "", GITHUB_TOKEN: "" },
      disableLoginShell: true,
      appServer: createSupervisionAppServerOptions(),
      appServerRuntimeFingerprint: "codex-runtime-v1",
    };

    const materialized = await startOrResumeThread(commonParams);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/fork",
      "thread/unsubscribe",
      "thread/start",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({
      threadId: sourceThreadId,
      includeTurns: true,
    });
    const forkParams = request.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(forkParams).toMatchObject({
      threadId: sourceThreadId,
      lastTurnId,
      excludeTurns: true,
      developerInstructions: agentWorkspaceDeveloperInstructions,
      config: {
        project_doc_max_bytes: 0,
        allow_login_shell: false,
        shell_environment_policy: {
          experimental_use_profile: false,
          set: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        },
      },
    });
    expect(forkParams).not.toHaveProperty("model");
    expect(forkParams).not.toHaveProperty("modelProvider");
    expect(forkParams).not.toHaveProperty("dynamicTools");
    expect(forkParams).not.toHaveProperty("environments");
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId: probeThreadId });
    const startParams = request.mock.calls[3]?.[1] as Record<string, unknown>;
    expect(startParams).toMatchObject({
      model: "native-effective",
      modelProvider: "native-provider",
      developerInstructions: agentWorkspaceDeveloperInstructions,
      dynamicTools,
      environments: [{ environmentId: "local", cwd: workspaceDir }],
      config: {
        project_doc_max_bytes: 0,
        allow_login_shell: false,
        shell_environment_policy: {
          experimental_use_profile: false,
          set: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        },
      },
    });
    expect(startParams.model).not.toBe(attempt.modelId);
    expect(request.mock.calls[4]?.[1]).toEqual({
      threadId: finalThreadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Visible question" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible answer" }],
          phase: "final_answer",
        },
      ],
    });
    expect(JSON.stringify(request.mock.calls[4]?.[1])).not.toContain("Private reasoning");
    expect(JSON.stringify(request.mock.calls[4]?.[1])).not.toContain("secret-tool");
    expect(materialized).toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      agentWorkspaceDeveloperInstructions,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "forked" },
    });
    expect(materialized.pendingSupervisionBranch).toBeUndefined();
    expect(materialized.historyCoveredThrough).not.toBe(new Date(0).toISOString());
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: finalThreadId,
      model: "native-effective",
      modelProvider: "native-provider",
      preserveNativeModel: true,
      agentWorkspaceDeveloperInstructions,
      conversationSourceTransferComplete: true,
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        commonParams.appServer,
        agentDir,
      ),
    });

    request.mockClear();
    const resumed = await startOrResumeThread({
      ...commonParams,
      appServerRuntimeFingerprint: "codex-runtime-v2",
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/read",
      "thread/resume",
      "thread/inject_items",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({ threadId: finalThreadId, includeTurns: false });
    expect(request.mock.calls[1]?.[1]).toEqual({ threadId: finalThreadId, includeTurns: false });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("model");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("modelProvider");
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      developerInstructions: agentWorkspaceDeveloperInstructions,
      config: { project_doc_max_bytes: 0 },
    });
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      threadId: finalThreadId,
      items: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining(agentWorkspaceDeveloperInstructions),
            },
          ],
        },
      ],
    });
    expect(resumed).toMatchObject({
      threadId: finalThreadId,
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
      lifecycle: { action: "resumed" },
    });
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        commonParams.appServer,
        agentDir,
      ),
    });
  });
});
