import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";
import { resumeCodexAppServerThread } from "./thread-resume.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

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
      projectId: null,
      cliVersion: CODEX_APP_SERVER_VERSION,
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

function createClient(requestImpl: (method: string, params: unknown) => unknown) {
  const request = vi.fn(
    async (method: string, params: unknown) => await requestImpl(method, params),
  );
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

  it.each(["unsubscribed", "notSubscribed", "notLoaded"] as const)(
    "releases a structured RPC failure with native status %s and keeps the client reusable",
    async (status) => {
      const rejection = new CodexAppServerRpcError(
        { code: -32_603, message: "resume response assembly failed" },
        "thread/resume",
      );
      const { client, request } = createClient(async (method) => {
        if (method === "thread/resume") {
          throw rejection;
        }
        return { status };
      });
      const abandonClient = vi.fn(async () => undefined);
      const assertCurrent = vi.fn();

      await expect(
        resumeCodexAppServerThread({
          client,
          abandonClient,
          request: { threadId: "thread-1", excludeTurns: true },
          assertCurrent,
        }),
      ).rejects.toBe(rejection);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/resume",
        "thread/unsubscribe",
      ]);
      expect(abandonClient).not.toHaveBeenCalled();
      expect(request).toHaveBeenLastCalledWith(
        "thread/unsubscribe",
        { threadId: "thread-1" },
        { timeoutMs: 5_000, assertCurrent },
      );
    },
  );

  it("preserves an exact overload rejection without releasing the subscription", async () => {
    const rejection = new CodexAppServerRpcError(
      { code: -32_001, message: "resume response assembly failed" },
      "thread/resume",
    );
    const { client, request } = createClient(async () => {
      throw rejection;
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeCodexAppServerThread({ client, abandonClient, request: { threadId: "thread-1" } }),
    ).rejects.toBe(rejection);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(abandonClient).not.toHaveBeenCalled();
  });

  it("preserves a physical pre-write ownership rejection without cleanup or retirement", async () => {
    const harness = createClientHarness();
    const rejection = new CodexAdoptedThreadActiveError();
    const abandonClient = vi.fn(async () => undefined);
    try {
      await expect(
        resumeCodexAppServerThread({
          client: harness.client,
          abandonClient,
          request: { threadId: "thread-1" },
          assertCurrent: () => {
            throw rejection;
          },
          isPrewriteOwnershipError: (error) => error instanceof CodexAdoptedThreadActiveError,
        }),
      ).rejects.toBe(rejection);
      expect(harness.writes).toEqual([]);
      expect(harness.client.getCloseError()).toBeUndefined();
      expect(abandonClient).not.toHaveBeenCalled();
    } finally {
      harness.client.close();
    }
  });

  it("retires the exact client after a written structured failure loses cleanup ownership", async () => {
    const harness = createClientHarness();
    let current = true;
    const abandonClient = vi.fn(async () => harness.client.close());
    try {
      const resume = resumeCodexAppServerThread({
        client: harness.client,
        abandonClient,
        request: { threadId: "thread-1" },
        assertCurrent: () => {
          if (!current) {
            throw new CodexAdoptedThreadActiveError();
          }
        },
        isPrewriteOwnershipError: (error) => error instanceof CodexAdoptedThreadActiveError,
      });
      const failure = expect(resume).rejects.toMatchObject({
        name: "CodexAppServerUnsafeSubscriptionError",
        cause: { code: -32_603, message: "resume response assembly failed" },
      });
      const writtenText = harness.writes[0];
      expect(writtenText).toBeDefined();
      const written = JSON.parse(writtenText ?? "");
      expect(written).toMatchObject({ method: "thread/resume", params: { threadId: "thread-1" } });
      current = false;
      harness.send({
        id: written.id,
        error: { code: -32_603, message: "resume response assembly failed" },
      });
      await failure;
      expect(harness.writes).toHaveLength(1);
      expect(abandonClient).toHaveBeenCalledOnce();
      expect(harness.client.getCloseError()).toBeDefined();
    } finally {
      harness.client.close();
    }
  });

  it("retires the exact client when structured RPC cleanup cannot release the thread", async () => {
    const rejection = new CodexAppServerRpcError(
      { code: -32_603, message: "resume response assembly failed" },
      "thread/resume",
    );
    const { client, request } = createClient(async (method) => {
      if (method === "thread/resume") {
        throw rejection;
      }
      throw new Error("thread unsubscribe failed");
    });
    const abandonClient = vi.fn(async () => undefined);

    await expect(
      resumeCodexAppServerThread({
        client,
        abandonClient,
        request: { threadId: "thread-1", excludeTurns: true },
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerUnsafeSubscriptionError",
      cause: rejection,
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/unsubscribe",
    ]);
    expect(abandonClient).toHaveBeenCalledOnce();
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
