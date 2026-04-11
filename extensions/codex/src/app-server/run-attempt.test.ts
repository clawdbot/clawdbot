import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  abortAgentHarnessRun,
  queueAgentHarnessMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";
import { writeCodexAppServerBinding } from "./session-binding.js";
import { buildThreadResumeParams, buildTurnStartParams } from "./thread-lifecycle.js";

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
    modelId: "gpt-5.4-codex",
    model: {
      id: "gpt-5.4-codex",
      name: "gpt-5.4-codex",
      provider: "codex",
      api: "openai-codex-responses",
      input: ["text"],
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_000,
    } as Model<Api>,
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

describe("runCodexAppServerAttempt", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-"));
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("forwards queued user input and aborts the active app-server turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-5.4-codex", modelProvider: "openai" };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/start")).toBe(true),
    );

    expect(queueAgentHarnessMessage("session-1", "more context")).toBe(true);
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/steer")).toBe(true),
    );
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/interrupt")).toBe(true),
    );

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          params: expect.objectContaining({
            model: "gpt-5.4-codex",
            modelProvider: "openai",
          }),
        },
        {
          method: "turn/steer",
          params: {
            threadId: "thread-1",
            expectedTurnId: "turn-1",
            input: [{ type: "text", text: "more context" }],
          },
        },
        {
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn-1" },
        },
      ]),
    );
  });

  it("forwards image attachments to the app-server turn input", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-5.4-codex", modelProvider: "openai" };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.model = {
      ...params.model,
      input: ["text", "image"],
    } as Model<Api>;
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2UtYnl0ZXM=",
      },
    ];

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/start")).toBe(true),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "turn/start",
          params: expect.objectContaining({
            input: [
              { type: "text", text: "hello" },
              { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
            ],
          }),
        },
      ]),
    );
  });

  it("does not drop turn completion notifications emitted while turn/start is in flight", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return { thread: { id: "thread-1" }, model: "gpt-5.4-codex", modelProvider: "openai" };
      }
      if (method === "turn/start") {
        await notify({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        });
        return { turn: { id: "turn-1", status: "completed" } };
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );

    await expect(
      runCodexAppServerAttempt(
        createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      ),
    ).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
    });
  });

  it("times out app-server startup before thread setup can hang forever", async () => {
    __testing.setCodexAppServerClientFactoryForTests(() => new Promise<never>(() => undefined));
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "codex app-server startup timed out",
    );
    expect(queueAgentHarnessMessage("session-1", "after timeout")).toBe(false);
  });

  it("times out turn start before the active run handle is installed", async () => {
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" }, model: "gpt-5.4-codex", modelProvider: "openai" };
        }
        if (method === "turn/start") {
          return await new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error("turn/start timed out")),
              Math.max(100, options?.timeoutMs ?? 0),
            );
          });
        }
        return {};
      },
    );
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn/start timed out");
    expect(queueAgentHarnessMessage("session-1", "after timeout")).toBe(false);
  });

  it("keeps extended history enabled when resuming a bound Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-existing" }, modelProvider: "openai" };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/start")).toBe(true),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/resume",
          params: {
            threadId: "thread-existing",
            model: "gpt-5.4-codex",
            modelProvider: "openai",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "workspace-write",
            persistExtendedHistory: true,
          },
        },
      ]),
    );
  });

  it("passes configured app-server policy, sandbox, service tier, and model on resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.2",
      modelProvider: "openai",
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread-existing" }, modelProvider: "openai" };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-1", status: "inProgress" } };
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          approvalPolicy: "on-request",
          approvalsReviewer: "guardian_subagent",
          sandbox: "danger-full-access",
          serviceTier: "priority",
        },
      },
    });
    await vi.waitFor(() =>
      expect(requests.some((entry) => entry.method === "turn/start")).toBe(true),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/resume",
          params: {
            threadId: "thread-existing",
            model: "gpt-5.4-codex",
            modelProvider: "openai",
            approvalPolicy: "on-request",
            approvalsReviewer: "guardian_subagent",
            sandbox: "danger-full-access",
            serviceTier: "priority",
            persistExtendedHistory: true,
          },
        },
        {
          method: "turn/start",
          params: expect.objectContaining({
            approvalPolicy: "on-request",
            approvalsReviewer: "guardian_subagent",
            serviceTier: "priority",
            model: "gpt-5.4-codex",
          }),
        },
      ]),
    );
  });

  it("builds resume and turn params from the currently selected OpenClaw model", () => {
    const params = createParams("/tmp/session.jsonl", "/tmp/workspace");
    const appServer = {
      start: {
        transport: "stdio" as const,
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      requestTimeoutMs: 60_000,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "danger-full-access" as const,
      serviceTier: "priority",
    };

    expect(buildThreadResumeParams(params, { threadId: "thread-1", appServer })).toEqual({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "danger-full-access",
      serviceTier: "priority",
      persistExtendedHistory: true,
    });
    expect(
      buildTurnStartParams(params, { threadId: "thread-1", cwd: "/tmp/workspace", appServer }),
    ).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/tmp/workspace",
        model: "gpt-5.4-codex",
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
        serviceTier: "priority",
      }),
    );
  });
});
