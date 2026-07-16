// Codex tests cover compact plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession as maybeCompactCodexAppServerSessionImpl } from "./compact.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexServerNotification } from "./protocol.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  clearCodexAppServerBindingForThread,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;

type MaybeCompactOptions = Omit<
  NonNullable<Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]>,
  "bindingStore"
> & {
  bindingStore?: NonNullable<
    Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]
  >["bindingStore"];
};

function setCodexAppServerClientFactoryForTest(factory: CodexAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

function maybeCompactCodexAppServerSession(
  params: Parameters<typeof maybeCompactCodexAppServerSessionImpl>[0],
  options: MaybeCompactOptions = {},
) {
  const identity = sessionBindingIdentity({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  registerCodexTestSessionIdentity(
    params.sessionFile,
    params.sessionId,
    params.sessionKey,
    identity.agentId,
  );
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  return maybeCompactCodexAppServerSessionImpl(params, {
    ...options,
    bindingStore: options.bindingStore ?? testCodexAppServerBindingStore,
    ...(clientFactory ? { clientFactory } : {}),
  });
}

async function writeTestBinding(
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
  sessionKey = "agent:main:session-1",
): Promise<string> {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const identity = sessionBindingIdentity({ sessionId: "session-1", sessionKey });
  registerCodexTestSessionIdentity(sessionFile, "session-1", sessionKey, identity.agentId);
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-1",
    cwd: tempDir,
    ...options,
  });
  return sessionFile;
}

async function writeSupervisedTestBinding(
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
): Promise<string> {
  return writeTestBinding({
    connectionScope: "supervision",
    supervisionSourceThreadId: "source-thread-1",
    preserveNativeModel: true,
    conversationSourceTransferComplete: true,
    model: "gpt-5.4",
    modelProvider: "openai",
    appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
      resolveCodexSupervisionAppServerRuntimeOptions({
        pluginConfig: { supervision: { enabled: true } },
      }),
    ),
    ...options,
  });
}

function startCompaction(sessionFile: string, options: { currentTokenCount?: number } = {}) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    ...options,
  });
}

function startSandboxedCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  });
}

function startNodeExecCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    trigger: "manual",
    config: { tools: { exec: { host: "node", node: "worker-1" } } },
  });
}

type CompactResult = NonNullable<Awaited<ReturnType<typeof maybeCompactCodexAppServerSession>>>;

function requireCompactResult(result: CompactResult | undefined): CompactResult {
  if (!result) {
    throw new Error("expected compaction result");
  }
  return result;
}

function compactDetails(result: CompactResult): Record<string, unknown> {
  return (result.result?.details ?? {}) as Record<string, unknown>;
}

async function flushAsyncTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function expectExternalMutationBlockedDuringNativeRequest(params: {
  releaseExternalMutation: () => void;
  isExternalMutationStarted: () => boolean;
  isExternalMutationFinished: () => boolean;
}): Promise<Record<string, never>> {
  params.releaseExternalMutation();
  await flushAsyncTasks();
  expect(params.isExternalMutationStarted()).toBe(true);
  expect(params.isExternalMutationFinished()).toBe(false);
  return {};
}

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
  });

  afterEach(async () => {
    resetCodexAppServerClientFactoryForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("waits for native app-server compaction completion", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(fake.client["addNotificationHandler"]).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensBefore).toBe(123);
    expect(result.result?.tokensAfter).toBeUndefined();
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(details.signal).toBe("thread/compact/start");
    expect(details.pending).toBe(false);
    expect(details.completed).toBe(true);
  });

  it("uses the exact prepared Platform key for native compaction", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn<CodexAppServerClientFactory>(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
          provider: "openai",
          model: "gpt-5.5",
          resolvedApiKey: "prepared-platform-key",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.5",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        },
        { clientFactory: factory },
      ),
    );

    expect(result.ok).toBe(true);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
      }),
    );
    expect(factory.mock.calls[0]?.[0]).not.toHaveProperty("authProfileId");
  });

  it("fails closed when prepared Platform compaction has no key", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
          provider: "openai",
          model: "gpt-5.5",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            harnessAuthProvider: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.5",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        },
        { clientFactory: factory },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Prepared Codex Platform compaction route is missing its resolved API key.",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses the native supervision runtime and auth for supervised bindings", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    const sessionFile = await writeSupervisedTestBinding({
      authProfileId: "openai:binding-profile",
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
          authProfileId: "openai:outer-profile",
        },
        {
          clientFactory: factory,
          pluginConfig: { supervision: { enabled: true } },
        },
      ),
    );

    expect(result.ok).toBe(true);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
  });

  it("fails closed when a supervised binding is no longer enabled", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    const sessionFile = await writeSupervisedTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
        },
        { clientFactory: factory, pluginConfig: { supervision: { enabled: false } } },
      ),
    );

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason:
        "Codex supervision is disabled; refusing to open a native user-home supervised session",
    });
    expect(factory).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      connectionScope: "supervision",
    });
  });

  it("skips native app-server compaction for automatic budget triggers", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "budget",
        currentTokenCount: 456,
      }),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server owns automatic compaction");
    expect(result.result?.tokensBefore).toBe(456);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "non_manual_trigger",
      trigger: "budget",
    });
  });

  it("starts native app-server compaction for post-context-engine budget requests", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.result?.tokensBefore).toBe(456);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: false,
      completed: true,
      request: "after_context_engine",
      trigger: "budget",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
      },
    });
    expect(
      (await readCodexAppServerBinding(sessionFile))?.contextEngine?.projection,
    ).toBeUndefined();
  });

  it("preserves projection when aborted before guarded native compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const abortController = new AbortController();
    abortController.abort("cancelled");
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
          abortSignal: abortController.signal,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server compaction aborted before native compaction");
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "aborted_before_native_compaction",
      request: "after_context_engine",
      trigger: "budget",
      expectedThreadId: "thread-1",
      currentThreadId: "thread-1",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
      contextEngine: {
        projection: {
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
  });

  it("skips post-context-engine native compaction when the binding changes before projection clear", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const originalContextEngine = {
      schemaVersion: 1 as const,
      engineId: "lossless-claw",
      policyFingerprint: "policy-1",
      projection: {
        schemaVersion: 1 as const,
        mode: "thread_bootstrap" as const,
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    };
    const sessionFile = await writeTestBinding({
      contextEngine: originalContextEngine,
    });
    let bindingReads = 0;
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      read: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.read>) => {
        const result = await testCodexAppServerBindingStore.read(...args);
        if (bindingReads++ === 0) {
          seedCodexTestBinding(sessionFile, {
            threadId: "thread-2",
            cwd: tempDir,
            contextEngine: {
              ...originalContextEngine,
              projection: {
                schemaVersion: 1,
                mode: "thread_bootstrap",
                epoch: "epoch-2",
                fingerprint: "fingerprint-2",
              },
            },
          });
        }
        return result;
      }),
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true, bindingStore },
      ),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server binding changed before native compaction");
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "binding_changed_before_native_compaction",
      request: "after_context_engine",
      trigger: "budget",
      expectedThreadId: "thread-1",
      currentThreadId: "thread-2",
    });
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-2",
      contextEngine: {
        projection: {
          epoch: "epoch-2",
          fingerprint: "fingerprint-2",
        },
      },
    });
  });

  it("blocks same-process binding writes until guarded native compaction starts", async () => {
    let releaseExternalWrite!: () => void;
    const externalWriteGate = new Promise<void>((resolve) => {
      releaseExternalWrite = resolve;
    });
    let externalWriteStarted = false;
    let externalWriteFinished = false;
    const fake = createFakeCodexClient();
    fake.request.mockImplementation(async () => {
      const response = await expectExternalMutationBlockedDuringNativeRequest({
        releaseExternalMutation: releaseExternalWrite,
        isExternalMutationStarted: () => externalWriteStarted,
        isExternalMutationFinished: () => externalWriteFinished,
      });
      setImmediate(fake.completeCompaction);
      return response;
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
    const externalWrite = (async () => {
      await externalWriteGate;
      externalWriteStarted = true;
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-2",
        cwd: tempDir,
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint: "policy-2",
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-2",
          },
        },
      });
      externalWriteFinished = true;
    })();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    await externalWrite;
    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-2",
      contextEngine: {
        policyFingerprint: "policy-2",
        projection: {
          epoch: "epoch-2",
        },
      },
    });
  });

  it("blocks same-process binding clears until guarded native compaction starts", async () => {
    let releaseExternalClear!: () => void;
    const externalClearGate = new Promise<void>((resolve) => {
      releaseExternalClear = resolve;
    });
    let externalClearStarted = false;
    let externalClearFinished = false;
    const fake = createFakeCodexClient();
    fake.request.mockImplementation(async () => {
      const response = await expectExternalMutationBlockedDuringNativeRequest({
        releaseExternalMutation: releaseExternalClear,
        isExternalMutationStarted: () => externalClearStarted,
        isExternalMutationFinished: () => externalClearFinished,
      });
      setImmediate(fake.completeCompaction);
      return response;
    });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          fingerprint: "fingerprint-1",
        },
      },
    });
    const externalClear = (async () => {
      await externalClearGate;
      externalClearStarted = true;
      const cleared = await clearCodexAppServerBindingForThread(sessionFile, "thread-1");
      externalClearFinished = true;
      expect(cleared).toBe(true);
    })();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
          currentTokenCount: 456,
        },
        { allowNonManualNativeRequest: true },
      ),
    );

    await externalClear;
    expect(fake.request).toHaveBeenCalledWith(
      "thread/compact/start",
      { threadId: "thread-1" },
      { timeoutMs: 60_000 },
    );
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("skips native app-server compaction when trigger is omitted", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        currentTokenCount: 789,
      }),
    );

    expect(fake.request).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("codex app-server owns automatic compaction");
    expect(result.result?.tokensBefore).toBe(789);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      skipped: true,
      reason: "non_manual_trigger",
      trigger: "unknown",
    });
  });

  it("blocks native app-server compaction when the current OpenClaw session is sandboxed", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startSandboxedCompaction(sessionFile));

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain(
      "Codex-native native compaction is unavailable because OpenClaw sandboxing is active for this session.",
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("blocks native app-server compaction when exec host=node is active", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startNodeExecCompaction(sessionFile));

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain(
      "Codex-native native compaction is unavailable because OpenClaw exec host=node is active for this session.",
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("does not finish until the matching native compaction turn completes", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    let settled = false;
    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    await flushAsyncTasks();
    expect(settled).toBe(false);
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", threadId: "thread-1", status: "completed" },
      },
    });
    const result = requireCompactResult(await pendingResult);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensAfter).toBeUndefined();
    expect(compactDetails(result).tokenUsageSource).toBeUndefined();
    expect(compactDetails(result).signal).toBe("thread/compact/start");
  });

  it("lets terminal interruption win after the compaction item completes", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile);
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-hook", threadId: "thread-1", status: "inProgress" },
      },
    });
    for (const method of ["item/started", "item/completed"] as const) {
      fake.emit({
        method,
        params: {
          threadId: "thread-1",
          turnId: "compact-turn-hook",
          item: { id: "compact-item-hook", type: "contextCompaction" },
        },
      });
    }
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-hook", threadId: "thread-1", status: "interrupted" },
      },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction turn ended with status interrupted",
    });
  });

  it("fails when the native compaction turn terminates before its item starts", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledOnce();
    });
    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-failed", threadId: "thread-1", status: "inProgress" },
      },
    });
    fake.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-failed", threadId: "thread-1", status: "failed" },
      },
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction turn ended with status failed",
    });
  });

  it("accepts the terminal interrupt response when its notification is missing", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "manual",
      },
      { clientFactory: async () => fake.client, nativeCompletionTimeoutMs: 10 },
    );
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-stalled", threadId: "thread-1", status: "inProgress" },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        {
          threadId: "thread-1",
          turnId: "compact-turn-stalled",
        },
        { timeoutMs: 30_000 },
      );
    });
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.closeAndWait).not.toHaveBeenCalled();

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server confirmed native compaction interruption",
    });
  });

  it("accepts an already-terminal interrupt after the completion notification is dropped", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      interruptError: new CodexAppServerRpcError(
        { code: -32_600, message: "no active turn to interrupt" },
        "turn/interrupt",
      ),
    });
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "manual",
      },
      { clientFactory: async () => fake.client, nativeCompletionTimeoutMs: 10 },
    );
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-finished", threadId: "thread-1", status: "inProgress" },
      },
    });
    for (const method of ["item/started", "item/completed"] as const) {
      fake.emit({
        method,
        params: {
          threadId: "thread-1",
          turnId: "compact-turn-finished",
          item: { id: "compact-item-finished", type: "contextCompaction" },
        },
      });
    }

    await expect(pendingResult).resolves.toMatchObject({ ok: true, compacted: true });
    expect(fake.closeAndWait).not.toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeDefined();
  });

  it("retires a stalled client when interruption cannot be confirmed", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      rejectInterrupt: true,
    });
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "manual",
      },
      {
        clientFactory: async () => fake.client,
        nativeCompletionTimeoutMs: 250,
        nativeInterruptGraceMs: 10,
      },
    );
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-stuck", threadId: "thread-1", status: "inProgress" },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        {
          threadId: "thread-1",
          turnId: "compact-turn-stuck",
        },
        { timeoutMs: 10 },
      );
      expect(fake.closeAndWait).toHaveBeenCalledWith({
        exitTimeoutMs: 5_000,
        forceKillDelayMs: 250,
      });
      expect(fake.close).toHaveBeenCalledTimes(1);
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction did not reach terminal state after interruption",
    });
  });

  it("uses the configured compaction timeout for native completion", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      rejectInterrupt: true,
    });
    const sessionFile = await writeTestBinding();
    const nativeSetTimeout = globalThis.setTimeout;
    let triggerCompletionTimeout: (() => void) | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 1_000 && !triggerCompletionTimeout) {
          triggerCompletionTimeout = () => callback(...args);
          return nativeSetTimeout(() => undefined, 60_000);
        }
        return nativeSetTimeout(callback, delay, ...args);
      });

    try {
      const pendingResult = maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "manual",
          config: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } },
        },
        {
          clientFactory: async () => fake.client,
          nativeInterruptGraceMs: 10,
        },
      );
      await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
      fake.emit({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "compact-turn-configured", threadId: "thread-1", status: "inProgress" },
        },
      });

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
      expect(triggerCompletionTimeout).toBeDefined();
      triggerCompletionTimeout?.();
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        {
          threadId: "thread-1",
          turnId: "compact-turn-configured",
        },
        { timeoutMs: 10 },
      );
      await expect(pendingResult).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: "codex app-server compaction did not reach terminal state after interruption",
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("detaches a remote thread when its interrupted turn cannot be confirmed", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      rejectInterrupt: true,
    });
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "manual",
      },
      {
        clientFactory: async () => fake.client,
        pluginConfig: {
          appServer: { transport: "websocket", url: "ws://127.0.0.1:45001" },
        },
        nativeCompletionTimeoutMs: 250,
        nativeInterruptGraceMs: 10,
      },
    );
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledOnce());
    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-remote", threadId: "thread-1", status: "inProgress" },
      },
    });

    await expect(pendingResult).resolves.toMatchObject({ ok: false, compacted: false });
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("never detaches an unconfirmed remote supervised thread", async () => {
    const fake = createFakeCodexClient({
      autoCompleteCompaction: false,
      rejectInterrupt: true,
    });
    fake.closeAndWait.mockResolvedValueOnce(false);
    const pluginConfig = {
      supervision: { enabled: true },
      appServer: { transport: "websocket" as const, url: "ws://127.0.0.1:45001" },
    };
    const sessionFile = await writeSupervisedTestBinding({
      threadId: "thread-stuck-supervision",
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
        resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig }),
      ),
    });

    const pendingResult = maybeCompactCodexAppServerSession(
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        trigger: "manual",
      },
      {
        clientFactory: async () => fake.client,
        pluginConfig,
        nativeCompletionTimeoutMs: 10,
        nativeInterruptGraceMs: 10,
      },
    );

    const outcome = await Promise.race([
      pendingResult.then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);

    expect(outcome).toBe("pending");
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-stuck-supervision",
      connectionScope: "supervision",
    });
  });

  it("cancels a native compaction after the start request", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const abortController = new AbortController();

    let settled = false;
    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      abortSignal: abortController.signal,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledOnce();
    });
    abortController.abort();
    await flushAsyncTasks();
    expect(settled).toBe(false);

    fake.emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-aborted", threadId: "thread-1", status: "inProgress" },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith(
        "turn/interrupt",
        {
          threadId: "thread-1",
          turnId: "compact-turn-aborted",
        },
        { timeoutMs: 30_000 },
      );
    });

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server confirmed native compaction interruption",
    });
  });

  it("serializes native compaction requests for the same Codex thread", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const firstSessionFile = await writeTestBinding();
    const secondSessionFile = path.join(tempDir, "second-session.jsonl");
    registerCodexTestSessionIdentity(secondSessionFile, "session-2", "agent:main:session-2");
    await writeCodexAppServerBinding(secondSessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });

    const first = startCompaction(firstSessionFile);
    const second = maybeCompactCodexAppServerSession({
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      sessionFile: secondSessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledTimes(1);
    });

    fake.completeCompaction();
    await expect(first).resolves.toMatchObject({ ok: true, compacted: true });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledTimes(2);
    });

    fake.completeCompaction();
    await expect(second).resolves.toMatchObject({ ok: true, compacted: true });
  });

  it("cancels a queued same-thread compaction before acquiring a client", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const firstSessionFile = await writeTestBinding();
    const secondSessionFile = path.join(tempDir, "queued-session.jsonl");
    registerCodexTestSessionIdentity(secondSessionFile, "session-2", "agent:main:session-2");
    await writeCodexAppServerBinding(secondSessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    const abortController = new AbortController();

    const first = startCompaction(firstSessionFile);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledTimes(1);
    });
    const second = maybeCompactCodexAppServerSession({
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      sessionFile: secondSessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      abortSignal: abortController.signal,
    });
    await flushAsyncTasks();
    expect(factory).toHaveBeenCalledTimes(1);

    abortController.abort();
    await expect(second).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction aborted while waiting to start",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledTimes(1);

    fake.completeCompaction();
    await expect(first).resolves.toMatchObject({ ok: true, compacted: true });
  });

  it("keeps later compactions behind an active request after a queued waiter cancels", async () => {
    const fake = createFakeCodexClient({ autoCompleteCompaction: false });
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const firstSessionFile = await writeTestBinding();
    const secondSessionFile = path.join(tempDir, "canceled-queued-session.jsonl");
    const thirdSessionFile = path.join(tempDir, "later-session.jsonl");
    for (const [sessionFile, sessionId] of [
      [secondSessionFile, "session-2"],
      [thirdSessionFile, "session-3"],
    ] as const) {
      registerCodexTestSessionIdentity(sessionFile, sessionId, `agent:main:${sessionId}`);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-1",
        cwd: tempDir,
      });
    }
    const abortController = new AbortController();

    const first = startCompaction(firstSessionFile);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledTimes(1);
    });
    const second = maybeCompactCodexAppServerSession({
      sessionId: "session-2",
      sessionKey: "agent:main:session-2",
      sessionFile: secondSessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      abortSignal: abortController.signal,
    });
    abortController.abort();
    await expect(second).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "codex app-server compaction aborted while waiting to start",
    });

    const third = maybeCompactCodexAppServerSession({
      sessionId: "session-3",
      sessionKey: "agent:main:session-3",
      sessionFile: thirdSessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
    });
    await flushAsyncTasks();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.request).toHaveBeenCalledTimes(1);

    fake.completeCompaction();
    await expect(first).resolves.toMatchObject({ ok: true, compacted: true });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledTimes(2);
    });

    fake.completeCompaction();
    await expect(third).resolves.toMatchObject({ ok: true, compacted: true });
  });

  it("reuses the bound auth profile for native compaction", async () => {
    const fake = createFakeCodexClient();
    let seenAuthProfileId: string | undefined;
    setCodexAppServerClientFactoryForTest(async (options) => {
      seenAuthProfileId = options?.authProfileId ?? undefined;
      return fake.client;
    });
    const sessionFile = await writeTestBinding({ authProfileId: "openai:work" });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(seenAuthProfileId).toBe("openai:work");
    expect(result.ok).toBe(true);
  });

  it("reports missing thread bindings as failed native compaction", async () => {
    const sessionFile = path.join(tempDir, "missing-binding.jsonl");

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("no codex app-server thread binding");
    expect(result.failure?.reason).toBe("missing_thread_binding");
    expect(result.result).toBeUndefined();
  });

  it("preserves stale thread binding metadata for recovery and reports failed native compaction", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(
      new CodexAppServerRpcError(
        { code: -32_600, message: "thread not found: thread-1" },
        "thread/compact/start",
      ),
    );
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      authProfileId: "openai:work",
      model: "gpt-5.5-mini",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceTier: "priority",
    });

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-1");
    expect(preservedBinding?.authProfileId).toBe("openai:work");
    expect(preservedBinding?.model).toBe("gpt-5.5-mini");
    expect(preservedBinding?.approvalPolicy).toBe("on-request");
    expect(preservedBinding?.sandbox).toBe("workspace-write");
    expect(preservedBinding?.serviceTier).toBe("priority");
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("thread not found: thread-1");
    expect(result.failure?.reason).toBe("stale_thread_binding");
    expect(result.result).toBeUndefined();
    expect(fake.closeAndWait).not.toHaveBeenCalled();
  });

  it("retires the client before releasing an unconfirmed compaction start", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(new Error("thread/compact/start timed out"));
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "thread/compact/start timed out",
    });
    expect(fake.closeAndWait).toHaveBeenCalledWith({
      exitTimeoutMs: 5_000,
      forceKillDelayMs: 250,
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the lifecycle fence when an unconfirmed stdio process does not stop", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(new Error("thread/compact/start timed out"));
    fake.closeAndWait.mockResolvedValueOnce(false);
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({ threadId: "thread-stuck-stdio" });

    const outcome = await Promise.race([
      startCompaction(sessionFile).then(() => "settled" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 20);
      }),
    ]);

    expect(outcome).toBe("pending");
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeDefined();
  });

  it("detaches a guarded remote start after releasing the binding lock", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(new Error("thread/compact/start timed out"));
    fake.closeAndWait.mockResolvedValueOnce(false);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession(
        {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          sessionFile,
          workspaceDir: tempDir,
          trigger: "budget",
        },
        {
          allowNonManualNativeRequest: true,
          clientFactory: async () => fake.client,
          pluginConfig: {
            appServer: { transport: "websocket", url: "ws://127.0.0.1:45001" },
          },
        },
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "thread/compact/start timed out",
    });
    expect(fake.closeAndWait).toHaveBeenCalledOnce();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("retains the shared client lease through native compaction completion", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: false,
      completed: true,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.close).not.toHaveBeenCalled();
    expect(await readCodexAppServerBinding(sessionFile)).toBeDefined();
  });

  it("warns when stale OpenClaw compaction overrides are ignored", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      config: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        },
      },
    });

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        ignoredConfig: ["agents.defaults.compaction.model", "agents.defaults.compaction.provider"],
      },
    );
    warn.mockRestore();
  });

  it("warns when active agent compaction overrides are ignored", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({}, "agent:sara:session-1");

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:sara:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      config: {
        agents: {
          list: [
            {
              id: "sara",
              compaction: {
                model: "openai/gpt-5.4-mini",
                provider: "openai",
              },
            },
          ],
        },
      },
    });

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:sara:session-1",
        ignoredConfig: [
          "agents.list.sara.compaction.model",
          "agents.list.sara.compaction.provider",
        ],
      },
    );
    warn.mockRestore();
  });

  it("reports inherited compaction providers at the source path", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({}, "agent:nik:session-1");

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      config: {
        agents: {
          defaults: {
            compaction: {
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "nik",
              compaction: {
                model: "openai/gpt-5.4-mini",
              },
            },
          ],
        },
      },
    });

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:nik:session-1",
        ignoredConfig: ["agents.defaults.compaction.provider", "agents.list.nik.compaction.model"],
      },
    );
    warn.mockRestore();
  });

  it("warns for legacy Lossless config even when the Lossless context engine slot is active", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({}, "agent:lossless:session-1");
    const contextEngine: ContextEngine = {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({ ok: true, compacted: false, reason: "below threshold" })),
    };

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:lossless:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      contextEngine,
      config: {
        plugins: {
          slots: {
            contextEngine: "lossless-claw",
          },
        },
        agents: {
          list: [
            {
              id: "lossless",
              compaction: {
                model: "openai/gpt-5.4",
                provider: "lossless-claw",
              },
            },
          ],
        },
      },
    });

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:lossless:session-1",
        ignoredConfig: [
          "agents.list.lossless.compaction.model",
          "agents.list.lossless.compaction.provider",
        ],
      },
    );
    warn.mockRestore();
  });

  it("warns for inherited legacy Lossless provider when the Lossless slot is active", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({}, "agent:lossless-child:session-1");
    const contextEngine: ContextEngine = {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({ ok: true, compacted: false, reason: "below threshold" })),
    };

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:lossless-child:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      contextEngine,
      config: {
        plugins: {
          slots: {
            contextEngine: "lossless-claw",
          },
        },
        agents: {
          defaults: {
            compaction: {
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "lossless-child",
              compaction: {
                model: "openai/gpt-5.4-mini",
              },
            },
          ],
        },
      },
    });

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:lossless-child:session-1",
        ignoredConfig: [
          "agents.defaults.compaction.provider",
          "agents.list.lossless-child.compaction.model",
        ],
      },
    );
    warn.mockRestore();
  });

  it("fails closed when the persisted binding auth profile disagrees with the runtime request", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "openai:binding",
    });

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      trigger: "manual",
      authProfileId: "openai:runtime",
    });

    expect(result).toEqual({
      ok: false,
      compacted: false,
      reason: "auth profile mismatch for session binding",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("forwards compaction to native Codex even when a context engine owns compaction", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      },
    }));
    const maintain = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["maintain"]>>[0]) => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }),
    );
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain,
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        contextEngine,
        contextEngineRuntimeContext: { workspaceDir: tempDir, provider: "codex" },
        currentTokenCount: 123,
        trigger: "manual",
      }),
    );

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: false,
      completed: true,
    });
    expect(compact).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("requires a Codex binding instead of delegating to an owning context engine", async () => {
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 123,
      },
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
      trigger: "manual",
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "missing_thread_binding" },
    });
    expect(compact).not.toHaveBeenCalled();
  });
});

function createFakeCodexClient(
  options: {
    autoCompleteCompaction?: boolean;
    interruptError?: Error;
    rejectInterrupt?: boolean;
  } = {},
): {
  client: CodexAppServerClient;
  request: ReturnType<typeof vi.fn<CodexAppServerClient["request"]>>;
  close: ReturnType<typeof vi.fn>;
  closeAndWait: ReturnType<typeof vi.fn>;
  emit: (notification: CodexServerNotification) => void;
  completeCompaction: () => void;
} {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const closeHandlers = new Set<() => void>();
  const emit = (notification: CodexServerNotification): void => {
    for (const handler of handlers) {
      handler(notification);
    }
  };
  const completeCompaction = (): void => {
    emit({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", threadId: "thread-1", status: "inProgress" },
      },
    });
    emit({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "compact-turn-1",
        item: { id: "compact-item-1", type: "contextCompaction" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "compact-turn-1", threadId: "thread-1", status: "completed" },
      },
    });
  };
  const request = vi.fn<CodexAppServerClient["request"]>(
    async (method: string, params?: unknown) => {
      if (method === "turn/interrupt" && options.interruptError) {
        throw options.interruptError;
      }
      if (method === "turn/interrupt" && options.rejectInterrupt) {
        throw new Error("interrupt unavailable");
      }
      if (method === "thread/compact/start" && options.autoCompleteCompaction !== false) {
        const threadId = (params as { threadId?: unknown }).threadId;
        if (typeof threadId !== "string") {
          throw new Error("thread/compact/start requires threadId");
        }
        // Codex may emit item notifications before acknowledging the start RPC.
        emit({
          method: "turn/started",
          params: {
            threadId,
            turn: { id: "compact-turn-1", threadId, status: "inProgress" },
          },
        });
        emit({
          method: "item/started",
          params: {
            threadId,
            turnId: "compact-turn-1",
            item: { id: "compact-item-1", type: "contextCompaction" },
          },
        });
        emit({
          method: "item/completed",
          params: {
            threadId,
            turnId: "compact-turn-1",
            item: { id: "compact-item-1", type: "contextCompaction" },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: "compact-turn-1", threadId, status: "completed" },
          },
        });
      }
      return {};
    },
  );
  const close = vi.fn(() => {
    for (const handler of closeHandlers) {
      handler();
    }
  });
  const closeAndWait = vi.fn(async () => {
    close();
    return true;
  });
  const addNotificationHandler = vi.fn(
    (handler: (notification: CodexServerNotification) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  );
  return {
    client: {
      request,
      close,
      closeAndWait,
      addNotificationHandler,
      addCloseHandler: vi.fn((handler: () => void) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      }),
    } as unknown as CodexAppServerClient,
    request,
    close,
    closeAndWait,
    emit,
    completeCompaction,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
