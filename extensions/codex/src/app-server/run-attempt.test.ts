import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  abortAgentHarnessRun,
  queueAgentHarnessMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";
import { writeCodexAppServerBinding } from "./session-binding.js";
import { createCodexTestModel } from "./test-support.js";
import {
  buildThreadResumeParams,
  buildTurnStartParams,
  startOrResumeThread,
} from "./thread-lifecycle.js";

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
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-1") {
  return { thread: { id: threadId }, model: "gpt-5.4-codex", modelProvider: "openai" };
}

function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return { turn: { id: turnId, status } };
}

function createAppServerHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown>,
  options: { onStart?: (authProfileId: string | undefined) => void } = {},
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
  const request = vi.fn(async (method: string, params?: unknown) => {
    requests.push({ method, params });
    return requestImpl(method, params);
  });

  __testing.setCodexAppServerClientFactoryForTests(async (_startOptions, authProfileId) => {
    options.onStart?.(authProfileId);
    return {
      request,
      addNotificationHandler: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      addRequestHandler: () => () => undefined,
    } as never;
  });

  return {
    request,
    requests,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.some((entry) => entry.method === method)).toBe(true), {
        interval: 1,
      });
    },
    async completeTurn(params: { threadId: string; turnId: string }) {
      await notify({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: { id: params.turnId, status: "completed" },
        },
      });
    },
  };
}

function createStartedThreadHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
  options: { onStart?: (authProfileId: string | undefined) => void } = {},
) {
  return createAppServerHarness(async (method, params) => {
    const override = await requestImpl(method, params);
    if (override !== undefined) {
      return override;
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  }, options);
}

function expectResumeRequest(
  requests: Array<{ method: string; params: unknown }>,
  params: Record<string, unknown>,
) {
  expect(requests).toEqual(
    expect.arrayContaining([
      {
        method: "thread/resume",
        params,
      },
    ]),
  );
}

function createResumeHarness() {
  return createAppServerHarness(async (method) => {
    if (method === "thread/resume") {
      return { thread: { id: "thread-existing" }, modelProvider: "openai" };
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  });
}

async function writeExistingBinding(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    ...overrides,
  });
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
    const { requests, waitForMethod } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(queueAgentHarnessMessage("session-1", "more context")).toBe(true);
    await vi.waitFor(
      () => expect(requests.some((entry) => entry.method === "turn/steer")).toBe(true),
      { interval: 1 },
    );
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    await vi.waitFor(
      () => expect(requests.some((entry) => entry.method === "turn/interrupt")).toBe(true),
      { interval: 1 },
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

  it("does not leak unhandled rejections when shutdown closes before interrupt", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const { waitForMethod } = createStartedThreadHarness(async (method) => {
        if (method === "turn/interrupt") {
          throw new Error("codex app-server client is closed");
        }
      });
      const abortController = new AbortController();
      const params = createParams(
        path.join(tempDir, "session.jsonl"),
        path.join(tempDir, "workspace"),
      );
      params.abortSignal = abortController.signal;

      const run = runCodexAppServerAttempt(params);
      await waitForMethod("turn/start");
      abortController.abort("shutdown");

      await expect(run).resolves.toMatchObject({ aborted: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("forwards image attachments to the app-server turn input", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.model = createCodexTestModel("codex", ["text", "image"]);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2UtYnl0ZXM=",
      },
    ];

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
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
    let harness: ReturnType<typeof createAppServerHarness>;
    harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        return turnStartResult("turn-1", "completed");
      }
      return {};
    });

    await expect(
      runCodexAppServerAttempt(
        createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      ),
    ).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
    });
  });

  it("releases completion when a projector callback throws during turn/completed", async () => {
    // Regression for openclaw/openclaw#67996: a throw inside the projector's
    // turn/completed handler must not strand resolveCompletion, otherwise the
    // gateway session lane stays locked and every follow-up message queues
    // behind a run that will never resolve.
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
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
    params.onAgentEvent = () => {
      throw new Error("downstream consumer exploded");
    };
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(true),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "plan-1", type: "plan", text: "step one\nstep two" }],
        },
      },
    });
    await expect(run).resolves.toMatchObject({
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

    await expect(runCodexAppServerAttempt(params, { startupTimeoutFloorMs: 1 })).rejects.toThrow(
      "codex app-server startup timed out",
    );
    expect(queueAgentHarnessMessage("session-1", "after timeout")).toBe(false);
  });

  it("passes the selected auth profile into app-server startup", async () => {
    const seenAuthProfileIds: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(undefined, {
      onStart: (authProfileId) => seenAuthProfileIds.push(authProfileId),
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.authProfileId = "openai-codex:work";

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:work"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(seenAuthProfileIds).toEqual(["openai-codex:work"]);
    expect(requests.map((entry) => entry.method)).toContain("turn/start");
  });

  it("times out turn start before the active run handle is installed", async () => {
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method === "thread/start") {
          return { thread: { id: "thread-1" }, model: "gpt-5.4-codex", modelProvider: "openai" };
        }
        if (method === "turn/start") {
          return await new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("turn/start timed out")), options?.timeoutMs ?? 0);
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
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expectResumeRequest(requests, {
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      persistExtendedHistory: true,
    });
  });

  it("passes configured app-server policy, sandbox, service tier, and model on resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

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
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expectResumeRequest(requests, {
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "danger-full-access",
      serviceTier: "priority",
      persistExtendedHistory: true,
    });
    expect(requests).toEqual(
      expect.arrayContaining([
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

  it("preserves the bound auth profile when resume params omit authProfileId", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:bound",
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;

    const binding = await startOrResumeThread({
      client: {
        request: async (method: string) => {
          if (method === "thread/resume") {
            return { thread: { id: "thread-existing" }, modelProvider: "openai" };
          }
          throw new Error(`unexpected method: ${method}`);
        },
      } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: {
        start: {
          transport: "stdio",
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        requestTimeoutMs: 60_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });

    expect(binding.authProfileId).toBe("openai-codex:bound");
  });

  it("reuses the bound auth profile for app-server startup when params omit it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:bound",
      dynamicToolsFingerprint: "[]",
    });
    const seenAuthProfileIds: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createAppServerHarness(
      async (method: string) => {
        if (method === "thread/resume") {
          return { thread: { id: "thread-existing" }, modelProvider: "openai" };
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        throw new Error(`unexpected method: ${method}`);
      },
      { onStart: (authProfileId) => seenAuthProfileIds.push(authProfileId) },
    );
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:bound"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expect(seenAuthProfileIds).toEqual(["openai-codex:bound"]);
    expect(requests.map((entry) => entry.method)).toContain("turn/start");
  });
});
