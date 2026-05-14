import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  createParameterFreeTool,
  createPermissiveTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexThreadStartParams } from "./protocol.js";
import { createCodexTestModel } from "./test-support.js";
import { startOrResumeThread } from "./thread-lifecycle.js";

let tempDir: string;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createAppServerOptions(): Parameters<typeof startOrResumeThread>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
}

function threadStartResult(threadId = "thread-1", serviceTier: string | null = null) {
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
      cwd: tempDir,
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier,
    cwd: tempDir,
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

describe("Codex app-server dynamic tool schema boundary contract", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-schema-contract-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("passes prepared executable dynamic tool schemas through thread start unchanged", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const parameterFreeTool = createParameterFreeTool("message");
    const dynamicTool = {
      name: parameterFreeTool.name,
      description: parameterFreeTool.description,
      inputSchema: normalizedParameterFreeSchema(),
    };
    const request = vi.fn(async (method: string, _payload?: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [dynamicTool],
      appServer: createAppServerOptions(),
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [method, payload] = request.mock.calls[0] ?? [];
    if (method !== "thread/start") {
      throw new Error(`expected thread/start request, got ${method}`);
    }
    const startPayload = payload as CodexThreadStartParams | undefined;
    expect(startPayload?.dynamicTools).toStrictEqual([dynamicTool]);
    expect(startPayload?.cwd).toBe(workspaceDir);
    expect(startPayload?.model).toBe("gpt-5.4");
    expect(startPayload?.modelProvider).toBeUndefined();
    expect(startPayload?.approvalPolicy).toBe("never");
    expect(startPayload?.approvalsReviewer).toBe("user");
    expect(startPayload?.sandbox).toBe("workspace-write");
    expect(startPayload?.serviceName).toBe("OpenClaw");
    expect(startPayload?.experimentalRawEvents).toBe(true);
    expect(startPayload?.persistExtendedHistory).toBe(true);
    expect(typeof startPayload?.developerInstructions).toBe("string");
    expect(startPayload?.developerInstructions).toContain("OpenClaw");
  });

  it("accepts Codex app-server priority service tier responses", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-priority", "priority");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const binding = await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    expect(binding.threadId).toBe("thread-priority");
  });

  it("treats dynamic tool schema changes as thread-fingerprint changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const appServer = createAppServerOptions();
    let nextThreadId = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-${nextThreadId++}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [
        {
          name: "message",
          description: "Permissive test tool",
          inputSchema: { type: "object" },
        },
      ],
      appServer,
    });
    const permissiveTool = createPermissiveTool("message");
    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [
        {
          name: permissiveTool.name,
          description: permissiveTool.description,
          inputSchema: permissiveTool.parameters,
        },
      ],
      appServer,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
  });
});
