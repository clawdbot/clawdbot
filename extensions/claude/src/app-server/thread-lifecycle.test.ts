import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAppServerClient } from "./client.js";
import type { ResolvedClaudeAppServerConfig } from "./config.js";
import type { ClaudeDynamicToolBridge } from "./dynamic-tools.js";
import { isThreadNotFound, startOrResumeClaudeThread } from "./thread-lifecycle.js";
import {
  createClaudeAppServerBindingStore,
  type ClaudeAppServerBinding,
  type ClaudeAppServerBindingStore,
} from "./thread-store.js";
import {
  createClaudeTestBindingStateStore,
  createClaudeTestBindingStore,
} from "./thread-store.test-helpers.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const BASE_CFG: ResolvedClaudeAppServerConfig = {
  appServer: {
    command: "openclaw-claude-bridge",
    commandSource: "managed",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
    turnTimeoutMs: 600_000,
    turnIdleTimeoutMs: 90_000,
    progressIdleTimeoutMs: 300_000,
    subagentProgressIdleTimeoutMs: 600_000,
    queryThreadTimeoutMs: 1_800_000,
  },
  dynamicTools: { excludeNames: [] },
};

const STABLE_DYNAMIC_TOOLS_FP = "fp-dynamic-tools-v1";
const STABLE_DEVINSTRUCTIONS_FP = "fp-devinstructions-v1";
const IDENTITY = { sessionKey: "agent:main:direct:tester", sessionId: "sess-1" };

function makeBridge(): ClaudeDynamicToolBridge {
  return { specs: [], handlers: new Map() } as unknown as ClaudeDynamicToolBridge;
}

function makeClient(opts: {
  threadStartResponse?: unknown;
  threadResumeError?: Error;
  threadForkResponse?: unknown;
  threadForkError?: Error;
}): ClaudeAppServerClient {
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "thread/start") {
      return (
        opts.threadStartResponse ?? {
          thread: { id: "thr_fresh_001" },
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          cwd: "/tmp",
        }
      );
    }
    if (method === "thread/resume") {
      if (opts.threadResumeError) {
        throw opts.threadResumeError;
      }
      return { thread: { id: "thr_resumed_001" } };
    }
    if (method === "thread/fork") {
      if (opts.threadForkError) {
        throw opts.threadForkError;
      }
      return (
        opts.threadForkResponse ?? {
          thread: { id: "thr_forked_001" },
          model: "claude-sonnet-4-6",
          modelProvider: "anthropic",
          cwd: "/tmp",
        }
      );
    }
    return {};
  });
  return { request } as unknown as ClaudeAppServerClient;
}

function makeParams(): EmbeddedRunAttemptParams {
  return {
    sessionKey: IDENTITY.sessionKey,
    sessionId: IDENTITY.sessionId,
    modelId: "claude-sonnet-4-6",
    workspaceDir: "/tmp/ws",
  } as unknown as EmbeddedRunAttemptParams;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("startOrResumeClaudeThread", () => {
  let store: ClaudeAppServerBindingStore;

  beforeEach(() => {
    store = createClaudeTestBindingStore();
  });

  it("starts a fresh thread when no binding exists", async () => {
    const client = makeClient({});
    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("started");
    expect(result.threadId).toBe("thr_fresh_001");
    expect(result.rotationReason).toBeUndefined();
  });

  it("writes the binding on fresh start", async () => {
    const client = makeClient({});
    await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    const binding = await store.read(IDENTITY);
    expect(binding?.threadId).toBe("thr_fresh_001");
    expect(binding?.dynamicToolsFingerprint).toBe(STABLE_DYNAMIC_TOOLS_FP);
    expect(binding?.developerInstructionsFingerprint).toBe(STABLE_DEVINSTRUCTIONS_FP);
  });

  it("rejects when binding persistence fails", async () => {
    const brokenState = createClaudeTestBindingStateStore();
    brokenState.update = () => {
      throw new Error("plugin state write failed");
    };
    const brokenStore = createClaudeAppServerBindingStore(brokenState);
    const client = makeClient({});
    await expect(
      startOrResumeClaudeThread({
        client,
        params: makeParams(),
        cfg: BASE_CFG,
        bridge: makeBridge(),
        bindingStore: brokenStore,
        developerInstructions: "x",
        developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
        dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
        effectiveWorkspace: "/tmp/ws",
        nativeDisallowedTools: [],
      }),
    ).rejects.toThrow("plugin state write failed");
  });

  it("resumes when an existing binding matches the dynamic-tools fingerprint", async () => {
    await seedBinding(store, {
      threadId: "thr_existing_001",
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const client = makeClient({});
    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("resumed");
    expect(result.threadId).toBe("thr_existing_001");
  });

  it("forks the thread when dynamic-tools fingerprint changes (transcript preserved)", async () => {
    await seedBinding(store, {
      threadId: "thr_existing_002",
      dynamicToolsFingerprint: "fp-OLD",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/fork") {
        return { thread: { id: "thr_after_fork" } };
      }
      return {};
    });
    const client = { request } as unknown as ClaudeAppServerClient;
    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("forked");
    expect(result.threadId).toBe("thr_after_fork");
    expect(result.forkedFromThreadId).toBe("thr_existing_002");
    expect(result.rotationReason).toContain("dynamic tool catalog changed");
    const forkCallArgs = request.mock.calls.find((c) => c[0] === "thread/fork")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(forkCallArgs).toMatchObject({
      threadId: "thr_existing_002",
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
    });
    // No thread/start should fire: this is a fork, not a fresh rotation.
    expect(request.mock.calls.some((c) => c[0] === "thread/start")).toBe(false);
    // Binding rotates to the forked thread id with the new fingerprint.
    const binding = await store.read(IDENTITY);
    expect(binding?.threadId).toBe("thr_after_fork");
    expect(binding?.dynamicToolsFingerprint).toBe(STABLE_DYNAMIC_TOOLS_FP);
  });

  it("falls back to fresh thread/start when thread/fork reports thread-not-found", async () => {
    await seedBinding(store, {
      threadId: "thr_gone",
      dynamicToolsFingerprint: "fp-OLD",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const forkNotFound = Object.assign(new Error("thread not found"), { code: -32004 });
    const client = makeClient({
      threadForkError: forkNotFound,
      threadStartResponse: { thread: { id: "thr_fork_fallback" } },
    });
    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("started");
    expect(result.threadId).toBe("thr_fork_fallback");
    expect(result.rotationReason).toContain("dynamic tool catalog changed");
    expect(result.forkedFromThreadId).toBeUndefined();
  });

  it("carries current approvalPolicy + sandbox + disallowedTools into the fork (full policy envelope)", async () => {
    await seedBinding(store, {
      threadId: "thr_stale_policy",
      dynamicToolsFingerprint: "fp-OLD",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      approvalPolicy: "never",
    });
    const cfgWithNewPolicy: ResolvedClaudeAppServerConfig = {
      appServer: {
        command: "openclaw-claude-bridge",
        commandSource: "managed",
        approvalPolicy: "on-request",
        sandbox: { type: "readOnly" },
        turnTimeoutMs: 600_000,
        turnIdleTimeoutMs: 90_000,
        progressIdleTimeoutMs: 300_000,
        subagentProgressIdleTimeoutMs: 600_000,
        queryThreadTimeoutMs: 1_800_000,
      },
      dynamicTools: { excludeNames: [] },
    };
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/fork") {
        return { thread: { id: "thr_fork_with_policy" } };
      }
      return {};
    });
    const client = { request } as unknown as ClaudeAppServerClient;

    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: cfgWithNewPolicy,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: ["Bash", "Edit"],
    });

    expect(result.outcome).toBe("forked");
    const forkCallArgs = request.mock.calls.find((c) => c[0] === "thread/fork")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(forkCallArgs).toMatchObject({
      threadId: "thr_stale_policy",
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly" },
      disallowedTools: ["Bash", "Edit"],
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
    });
  });

  it("sends disallowedTools: [] when policy is empty so the fork clears parent's stale blocks", async () => {
    // Parent thread blocked Bash/Edit; current openclaw policy has been
    // relaxed (no disallowed natives). The fork must explicitly send
    // disallowedTools: [] so the server doesn't inherit the parent's
    // stale block list. Omitting the field would inherit parent →
    // stale Bash/Edit blocks persist into the new thread.
    await seedBinding(store, {
      threadId: "thr_relaxed_policy",
      dynamicToolsFingerprint: "fp-OLD",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "thread/fork") {
        return { thread: { id: "thr_fork_relaxed" } };
      }
      return {};
    });
    const client = { request } as unknown as ClaudeAppServerClient;

    await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });

    const forkCallArgs = request.mock.calls.find((c) => c[0] === "thread/fork")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(forkCallArgs).toBeDefined();
    expect(forkCallArgs?.disallowedTools).toEqual([]);
  });

  it("propagates non-thread-not-found errors from thread/fork", async () => {
    await seedBinding(store, {
      threadId: "thr_a",
      dynamicToolsFingerprint: "fp-OLD",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const transportError = new Error("ECONNRESET");
    const client = makeClient({ threadForkError: transportError });
    await expect(
      startOrResumeClaudeThread({
        client,
        params: makeParams(),
        cfg: BASE_CFG,
        bridge: makeBridge(),
        bindingStore: store,
        developerInstructions: "x",
        developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
        dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
        effectiveWorkspace: "/tmp/ws",
        nativeDisallowedTools: [],
      }),
    ).rejects.toThrow("ECONNRESET");
  });

  it("falls back to fresh start when thread/resume reports thread-not-found", async () => {
    await seedBinding(store, {
      threadId: "thr_stale",
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const notFound = Object.assign(new Error("thread not found"), { code: -32602 });
    const client = makeClient({
      threadResumeError: notFound,
      threadStartResponse: { thread: { id: "thr_recovered" } },
    });
    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("started");
    expect(result.threadId).toBe("thr_recovered");
    expect(result.rotationReason).toBeUndefined();
  });

  it("propagates non-thread-not-found errors from thread/resume", async () => {
    await seedBinding(store, {
      threadId: "thr_a",
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
    });
    const transportError = new Error("ECONNRESET");
    const client = makeClient({ threadResumeError: transportError });
    await expect(
      startOrResumeClaudeThread({
        client,
        params: makeParams(),
        cfg: BASE_CFG,
        bridge: makeBridge(),
        bindingStore: store,
        developerInstructions: "x",
        developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
        dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
        effectiveWorkspace: "/tmp/ws",
        nativeDisallowedTools: [],
      }),
    ).rejects.toThrow("ECONNRESET");
  });

  it("sends in-place patches for cwd/approval/developerInstructions divergence without rotating", async () => {
    await seedBinding(store, {
      threadId: "thr_patched",
      cwd: "/tmp/old-ws",
      approvalPolicy: "on-request",
      developerInstructionsFingerprint: "fp-OLD-instructions",
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
    });
    const request = vi.fn(async (_method: string, _params?: unknown) => ({
      thread: { id: "thr_patched" },
    }));
    const client = { request } as unknown as ClaudeAppServerClient;
    const result = await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "fresh",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/new-ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("resumed");
    const resumeCallArgs = request.mock.calls.find((c) => c[0] === "thread/resume")?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(resumeCallArgs).toMatchObject({
      threadId: "thr_patched",
      cwd: "/tmp/new-ws",
      approvalPolicy: "never",
      developerInstructions: "fresh",
    });
    // Binding gets the patched values so the next turn doesn't re-patch.
    const updated = await store.read(IDENTITY);
    expect(updated?.cwd).toBe("/tmp/new-ws");
    expect(updated?.approvalPolicy).toBe("never");
    expect(updated?.developerInstructionsFingerprint).toBe(STABLE_DEVINSTRUCTIONS_FP);
  });

  it("serializes same-session binding compare-and-mutate operations", async () => {
    await seedBinding(store, {
      threadId: "thr_serialized",
      cwd: "/tmp/old-ws",
      approvalPolicy: "on-request",
      developerInstructionsFingerprint: "fp-OLD-instructions",
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
    });

    let resolveFirstResume!: () => void;
    const firstResumeCanFinish = new Promise<void>((resolve) => {
      resolveFirstResume = resolve;
    });
    let firstResumeStarted!: () => void;
    const firstResumeDidStart = new Promise<void>((resolve) => {
      firstResumeStarted = () => {
        resolve();
      };
    });
    const firstRequest = vi.fn(async (_method: string, _params?: unknown) => {
      firstResumeStarted();
      await firstResumeCanFinish;
      return { thread: { id: "thr_serialized" } };
    });
    const secondRequest = vi.fn(async (_method: string, _params?: unknown) => ({
      thread: { id: "thr_serialized" },
    }));

    const first = startOrResumeClaudeThread({
      client: { request: firstRequest } as unknown as ClaudeAppServerClient,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "fresh",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/new-ws",
      nativeDisallowedTools: [],
    });
    await firstResumeDidStart;

    const second = startOrResumeClaudeThread({
      client: { request: secondRequest } as unknown as ClaudeAppServerClient,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "fresh",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/new-ws",
      nativeDisallowedTools: [],
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(secondRequest).not.toHaveBeenCalled();

    resolveFirstResume();
    await Promise.all([first, second]);

    const resumeCallArgs = secondRequest.mock.calls.find((c) => c[0] === "thread/resume")?.[1];
    expect(resumeCallArgs).toEqual({ threadId: "thr_serialized" });
  });

  it("skips the patch envelope when nothing diverged", async () => {
    await seedBinding(store, {
      threadId: "thr_no_patch",
      cwd: "/tmp/ws",
      approvalPolicy: "never",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
    });
    const request = vi.fn(async (_method: string, _params?: unknown) => ({
      thread: { id: "thr_no_patch" },
    }));
    const client = { request } as unknown as ClaudeAppServerClient;
    await startOrResumeClaudeThread({
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    const callArgs = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(callArgs?.cwd).toBeUndefined();
    expect(callArgs?.approvalPolicy).toBeUndefined();
    expect(callArgs?.developerInstructions).toBeUndefined();
  });
});

describe("isThreadNotFound", () => {
  it("matches a top-level 'thread not found' message (case-insensitive)", () => {
    expect(isThreadNotFound(new Error("Thread not found"))).toBe(true);
    expect(isThreadNotFound({ message: "thread NOT FOUND" })).toBe(true);
  });

  it("matches nested data.message", () => {
    expect(isThreadNotFound({ message: "rpc fail", data: { message: "thread not found" } })).toBe(
      true,
    );
  });

  it("returns false for unrelated errors", () => {
    expect(isThreadNotFound(new Error("ECONNRESET"))).toBe(false);
    expect(isThreadNotFound({ code: -32000, message: "internal error" })).toBe(false);
    expect(isThreadNotFound(null)).toBe(false);
    expect(isThreadNotFound("string error")).toBe(false);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function seedBinding(
  store: ClaudeAppServerBindingStore,
  overrides: Partial<ClaudeAppServerBinding> & { threadId: string },
): Promise<void> {
  await store.write(IDENTITY, {
    threadId: overrides.threadId,
    cwd: overrides.cwd ?? "/tmp/ws",
    model: overrides.model ?? "claude-sonnet-4-6",
    modelProvider: overrides.modelProvider ?? "anthropic",
    approvalPolicy: overrides.approvalPolicy ?? "never",
    approvalsReviewer: overrides.approvalsReviewer ?? "user",
    sandbox: overrides.sandbox ?? { type: "dangerFullAccess" },
    developerInstructionsFingerprint: overrides.developerInstructionsFingerprint,
    dynamicToolsFingerprint: overrides.dynamicToolsFingerprint,
  });
}
