// Codex tests cover configured-MCP thread ownership transitions.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

const sharedClientMocks = vi.hoisted(() => ({
  retainByInstanceId: undefined as
    | ((clientId: string | undefined) => { client: never; release: () => void } | undefined)
    | undefined,
}));

vi.mock("./shared-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared-client.js")>();
  return {
    ...actual,
    retainSharedCodexAppServerClientByInstanceId: (clientId: string | undefined) =>
      sharedClientMocks.retainByInstanceId
        ? sharedClientMocks.retainByInstanceId(clientId)
        : actual.retainSharedCodexAppServerClientByInstanceId(clientId),
  };
});

describe("startOrResumeThread — configured MCP ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir = "";

  beforeEach(() => {
    sharedClientMocks.retainByInstanceId = undefined;
    tempDir = tempDirs.make("openclaw-configured-mcp-ownership-");
    resetCodexTestBindingStore();
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
  });

  it.each([
    {
      name: "legacy native MCP fingerprint",
      binding: { dynamicToolsFingerprint: "[]", mcpServersFingerprint: "mcp-v1" },
    },
    { name: "missing dynamic fingerprint", binding: {} },
  ])("rotates $name when scheduled dynamic MCP takes ownership", async ({ binding }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      ...binding,
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        // The successor is not authoritative until its exact-predecessor CAS commits.
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-legacy",
        });
        return threadStartResult("thread-scheduled-v1");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      configuredMcpOwnershipVersion: 1,
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-scheduled-v1",
      configuredMcpOwnershipVersion: 1,
    });
  });

  it("replaces the single persistent main binding when scheduled MCP takes ownership", async () => {
    const sessionFile = path.join(tempDir, "session-main.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-main");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:main");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-main-ordinary",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string) => {
      if (method !== "thread/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-main-ordinary",
      });
      return threadStartResult("thread-main-scheduled");
    });
    const params = createParams(sessionFile, workspaceDir);
    params.sessionKey = "agent:main:main";

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      configuredMcpOwnershipVersion: 1,
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-main-scheduled",
      configuredMcpOwnershipVersion: 1,
    });
  });

  it("atomically alternates ordinary and scheduled ownership for a persistent named session without dual bindings", async () => {
    const sessionFile = path.join(tempDir, "session-alternating.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-alternating");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-ordinary-old",
      clientId: "client-old",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
      dynamicToolsFingerprint: "[]",
    });

    const released: string[] = [];
    const oldClient = {
      getInstanceId: () => "client-old",
      request: vi.fn(async (method: string, requestParams: { threadId?: string }) => {
        if (method === "thread/unsubscribe" && requestParams.threadId) {
          released.push(requestParams.threadId);
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(oldClient, { agentDir: workspaceDir });
    await retainCodexAppServerLiveThread(oldClient, "thread-ordinary-old");
    const releaseOldClientLease = vi.fn();
    sharedClientMocks.retainByInstanceId = (clientId) =>
      clientId === "client-old" ? { client: oldClient, release: releaseOldClientLease } : undefined;

    const successorIds = ["thread-scheduled-v1", "thread-ordinary-new", "thread-scheduled-v2"];
    const currentRequest = vi.fn(async (method: string, requestParams?: { threadId?: string }) => {
      if (method === "thread/start") {
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          threadId:
            successorIds.length === 3
              ? "thread-ordinary-old"
              : successorIds.length === 2
                ? "thread-scheduled-v1"
                : "thread-ordinary-new",
        });
        expect(released).toHaveLength(
          successorIds.length === 3 ? 0 : successorIds.length === 2 ? 1 : 2,
        );
        return threadStartResult(successorIds.shift()!);
      }
      if (method === "thread/unsubscribe" && requestParams?.threadId) {
        released.push(requestParams.threadId);
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const currentClient = {
      getInstanceId: () => "client-current",
      request: currentRequest,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(currentClient, { agentDir: workspaceDir });
    const releaseSibling = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(currentClient, "thread-sibling", releaseSibling);
    const common = {
      client: currentClient,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    };

    const scheduledV1 = await startOrResumeThread({
      ...common,
      configuredMcpOwnershipVersion: 1,
    });
    expect(scheduledV1).toMatchObject({
      threadId: "thread-scheduled-v1",
      configuredMcpOwnershipVersion: 1,
    });
    expect(released).toEqual(["thread-ordinary-old"]);
    expect(releaseOldClientLease).toHaveBeenCalledOnce();
    await expect(
      consumeCodexAppServerLiveThread(oldClient, "thread-ordinary-old"),
    ).resolves.toBeUndefined();
    await retainCodexAppServerLiveThread(
      currentClient,
      scheduledV1.threadId,
      undefined,
      scheduledV1.liveThreadConfigFingerprint,
    );

    const ordinary = await startOrResumeThread({
      ...common,
      mcpServersFingerprint: "mcp-v2",
    });
    expect(ordinary).toMatchObject({ threadId: "thread-ordinary-new" });
    expect(ordinary.configuredMcpOwnershipVersion).toBeUndefined();
    expect(released).toEqual(["thread-ordinary-old", "thread-scheduled-v1"]);
    await expect(
      consumeCodexAppServerLiveThread(currentClient, "thread-scheduled-v1"),
    ).resolves.toBeUndefined();
    await retainCodexAppServerLiveThread(
      currentClient,
      ordinary.threadId,
      undefined,
      ordinary.liveThreadConfigFingerprint,
    );

    const scheduledV2 = await startOrResumeThread({
      ...common,
      configuredMcpOwnershipVersion: 1,
    });
    expect(scheduledV2).toMatchObject({
      threadId: "thread-scheduled-v2",
      configuredMcpOwnershipVersion: 1,
    });
    expect(released).toEqual(["thread-ordinary-old", "thread-scheduled-v1", "thread-ordinary-new"]);
    await expect(
      consumeCodexAppServerLiveThread(currentClient, "thread-ordinary-new"),
    ).resolves.toBeUndefined();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-scheduled-v2",
      clientId: "client-current",
      configuredMcpOwnershipVersion: 1,
    });

    const sibling = await consumeCodexAppServerLiveThread(currentClient, "thread-sibling");
    expect(sibling).toBeDefined();
    expect(releaseSibling).not.toHaveBeenCalled();
    await sibling?.release("thread-sibling");
    expect(releaseSibling).toHaveBeenCalledWith("thread-sibling");
  });

  it("preserves the configured-MCP predecessor when successor start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      clientId: "client-start-failure",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        throw new Error("successor start failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-start-failure",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const releasePredecessor = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createAppServerOptions(),
        configuredMcpOwnershipVersion: 1,
        mcpServersFingerprintEvaluated: true,
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
      }),
    ).rejects.toThrow("successor start failed");
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-legacy",
    });
    expect(releasePredecessor).not.toHaveBeenCalled();
    const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
    expect(predecessor).toBeDefined();
    await predecessor?.release("thread-legacy");
  });

  it.each(["conflict", "error"] as const)(
    "cleans an uncommitted successor and preserves its predecessor after CAS $case",
    async (caseName) => {
      const sessionFile = path.join(tempDir, `session-${caseName}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-legacy",
        clientId: `client-cas-${caseName}`,
        cwd: workspaceDir,
        model: "gpt-5.4-codex",
        modelProvider: "openai",
        mcpServersFingerprint: "mcp-v1",
        dynamicToolsFingerprint: "[]",
      });
      const request = vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return threadStartResult("thread-uncommitted");
        }
        if (method === "thread/delete") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = {
        getInstanceId: () => `client-cas-${caseName}`,
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      const releasePredecessor = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        mutate: async (identity, mutation) => {
          if (mutation.kind === "replace-thread") {
            if (caseName === "error") {
              throw new Error("lost replacement lease");
            }
            return false;
          }
          return await testCodexAppServerBindingStore.mutate(identity, mutation);
        },
      };

      await expect(
        startOrResumeThreadImpl({
          bindingStore,
          client,
          params: createParams(sessionFile, workspaceDir),
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createAppServerOptions(),
          configuredMcpOwnershipVersion: 1,
          mcpServersFingerprintEvaluated: true,
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
        }),
      ).rejects.toThrow(
        caseName === "error" ? "lost replacement lease" : "Codex thread binding changed",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/start",
        "thread/delete",
      ]);
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-legacy",
      });
      expect(releasePredecessor).not.toHaveBeenCalled();
      const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
      expect(predecessor).toBeDefined();
      await predecessor?.release("thread-legacy");
    },
  );

  it("cleans the successor and preserves the predecessor on post-start abort", async () => {
    const sessionFile = path.join(tempDir, "session-abort.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-legacy",
      clientId: "client-abort",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      mcpServersFingerprint: "mcp-v1",
      dynamicToolsFingerprint: "[]",
    });
    const controller = new AbortController();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        controller.abort("test abort");
        return threadStartResult("thread-uncommitted");
      }
      if (method === "thread/delete") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = {
      getInstanceId: () => "client-abort",
      request,
      addNotificationHandler: () => () => undefined,
      addRequestHandler: () => () => undefined,
      addCloseHandler: () => () => undefined,
    } as never;
    ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
    const releasePredecessor = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(client, "thread-legacy", releasePredecessor);

    await expect(
      startOrResumeThread({
        client,
        params: createParams(sessionFile, workspaceDir),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createAppServerOptions(),
        configuredMcpOwnershipVersion: 1,
        mcpServersFingerprintEvaluated: true,
        nativeCodeModeEnabled: false,
        userMcpServersEnabled: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/delete"]);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-legacy",
    });
    expect(releasePredecessor).not.toHaveBeenCalled();
    const predecessor = await consumeCodexAppServerLiveThread(client, "thread-legacy");
    expect(predecessor).toBeDefined();
    await predecessor?.release("thread-legacy");
  });
});
