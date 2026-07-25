import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";

function resumeResponse(threadId: string, restoredTurns = 0) {
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
      cwd: "/repo",
      cliVersion: "0.139.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: Array.from({ length: restoredTurns }, (_, index) => ({
        id: `turn-${index}`,
        items: [],
        status: "completed",
        error: null,
      })),
    },
    model: "gpt-5.5-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/repo",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function createClient(requestImpl: (params: unknown) => unknown) {
  const request = vi.fn(async (_method: string, params: unknown) => await requestImpl(params));
  const client = { request } as unknown as CodexAppServerClient;
  return {
    client,
    request,
  };
}

describe("resumeCodexAppServerThread", () => {
  it("resumes the requested thread and keeps the client leased", async () => {
    const { client, request } = createClient(async () => resumeResponse("thread-1", 2));
    const abandonClient = vi.fn(async () => undefined);

    const response = await resumeCodexAppServerThread({
      client,
      abandonClient,
      request: { threadId: "thread-1", excludeTurns: true },
    });

    expect(response.thread.id).toBe("thread-1");
    expect(request).toHaveBeenCalledWith("thread/resume", expect.anything(), expect.anything());
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("leaves a proven RPC rejection on the reusable client", async () => {
    const rejection = new CodexAppServerRpcError(
      { code: -32_000, message: "thread not found" },
      "thread/resume",
    );
    const { client } = createClient(async () => {
      throw rejection;
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeCodexAppServerThread({
        client,
        abandonClient,
        request: { threadId: "thread-1", excludeTurns: true },
      }),
    ).rejects.toBe(rejection);
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("keeps the shared client after cancellation before the resume write", async () => {
    const rejection = Object.assign(new Error("thread/resume aborted"), {
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
      mayHaveWritten: false,
    });
    const { client } = createClient(async () => {
      throw rejection;
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeCodexAppServerThread({
        client,
        abandonClient,
        request: { threadId: "thread-1", excludeTurns: true },
      }),
    ).rejects.toBe(rejection);
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("retires the exact client when resume acceptance is indeterminate", async () => {
    const { client } = createClient(async () => {
      throw new Error("thread/resume timed out");
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeCodexAppServerThread({
        client,
        abandonClient,
        request: { threadId: "thread-1", excludeTurns: true },
      }),
    ).rejects.toThrow("thread/resume timed out");
    expect(abandonClient).toHaveBeenCalledOnce();
  });

  it("retires the exact client when the response names another thread", async () => {
    const { client } = createClient(async () => resumeResponse("thread-2"));
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeCodexAppServerThread({
        client,
        abandonClient,
        request: { threadId: "thread-1", excludeTurns: true },
      }),
    ).rejects.toThrow("returned thread-2 for thread-1");
    expect(abandonClient).toHaveBeenCalledOnce();
  });
});
