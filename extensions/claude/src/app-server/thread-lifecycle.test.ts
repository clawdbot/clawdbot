import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeAppServerClient } from "./client.js";
import type { ResolvedClaudeAppServerConfig } from "./config.js";
import type { ClaudeDynamicToolBridge } from "./dynamic-tools.js";
import {
  isThreadNotFound,
  isTransientToolPolicyTurn,
  startOrResumeClaudeThread,
} from "./thread-lifecycle.js";
import {
  createClaudeAppServerBindingStore,
  type ClaudeAppServerBinding,
  type ClaudeAppServerBindingStore,
} from "./thread-store.js";
import {
  createClaudeTestBindingStateStore,
  createClaudeTestBindingStore,
} from "./thread-store.test-helpers.js";
import { MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH } from "./version.js";

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

/**
 * Wrap a bare `request` stub as a client. Supplies `getServerInfo` reporting a
 * bridge at the tool-refresh floor, so tests exercising the refresh path see a
 * capable bridge rather than tripping the openclaw-d42b version gate.
 */
function asClient(request: unknown): ClaudeAppServerClient {
  return {
    request,
    getServerInfo: () => ({
      name: "@zeroaltitude/openclaw-claude-bridge",
      version: MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH,
    }),
  } as unknown as ClaudeAppServerClient;
}

function makeClient(opts: {
  threadStartResponse?: unknown;
  threadResumeError?: Error;
  threadForkResponse?: unknown;
  refreshToolsResponse?: unknown;
  refreshToolsError?: Error;
  threadForkError?: Error;
  /**
   * Version the bridge reports at `initialize`. Defaults to the floor that
   * enables the in-place refresh — a pre-0.7.6 bridge is gated off it, because
   * it answers `refreshed: true` while wedging the session's MCP binding
   * (openclaw-d42b).
   */
  bridgeVersion?: string;
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
    if (method === "thread/refresh_tools") {
      if (opts.refreshToolsError) {
        throw opts.refreshToolsError;
      }
      // Default: no live attempt, so callers must fall back to rotation.
      return opts.refreshToolsResponse ?? { refreshed: false };
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
  const getServerInfo = () => ({
    name: "@zeroaltitude/openclaw-claude-bridge",
    version: opts.bridgeVersion ?? MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH,
  });
  return { request, getServerInfo } as unknown as ClaudeAppServerClient;
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
    const client = asClient(request);
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
    const client = asClient(request);

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
    const client = asClient(request);

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
    const client = asClient(request);
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
      client: asClient(firstRequest),
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
      client: asClient(secondRequest),
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
    const client = asClient(request);
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

// ── transient narrowed-tool-policy turns (openclaw-tb9g) ────────────────────

function makeTriggerParams(trigger: string): EmbeddedRunAttemptParams {
  return { ...makeParams(), trigger } as unknown as EmbeddedRunAttemptParams;
}

function makeBridgeWithTools(names: string[]): ClaudeDynamicToolBridge {
  return {
    specs: names.map((name) => ({ name, description: "", inputSchema: { type: "object" } })),
    handlers: new Map(),
  } as unknown as ClaudeDynamicToolBridge;
}

describe("isTransientToolPolicyTurn", () => {
  it("is true for a memory-flush run", () => {
    expect(isTransientToolPolicyTurn(makeTriggerParams("memory"))).toBe(true);
  });

  it("is false for every other trigger", () => {
    for (const t of ["user", "heartbeat", "cron", "manual", "overflow"]) {
      expect(isTransientToolPolicyTurn(makeTriggerParams(t))).toBe(false);
    }
    expect(isTransientToolPolicyTurn(makeParams())).toBe(false);
  });
});

describe("startOrResumeClaudeThread — transient narrowed tool policy", () => {
  let transientStore: ClaudeAppServerBindingStore;

  beforeEach(() => {
    transientStore = createClaudeTestBindingStore();
  });

  async function seedFullCatalogBinding() {
    await transientStore.write(IDENTITY, {
      threadId: "thr_durable_full",
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
      approvalPolicy: BASE_CFG.appServer.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: BASE_CFG.appServer.sandbox,
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
    } as ClaudeAppServerBinding);
  }

  it("forks for a memory-flush turn but leaves the durable binding on the parent", async () => {
    await seedFullCatalogBinding();
    const result = await startOrResumeClaudeThread({
      client: makeClient({}),
      params: makeTriggerParams("memory"),
      cfg: BASE_CFG,
      bridge: makeBridgeWithTools(["read", "write"]),
      bindingStore: transientStore,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: "fp-memory-flush-narrowed",
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("forked");
    expect(result.transient).toBe(true);
    expect(result.threadId).toBe("thr_forked_001");
    // The whole point: the next ordinary turn must resume the parent.
    expect((await transientStore.read(IDENTITY))?.threadId).toBe("thr_durable_full");
  });

  it("registers the NARROWED catalog on the transient thread (policy is still enforced)", async () => {
    await seedFullCatalogBinding();
    const client = makeClient({});
    await startOrResumeClaudeThread({
      client,
      params: makeTriggerParams("memory"),
      cfg: BASE_CFG,
      bridge: makeBridgeWithTools(["read", "write"]),
      bindingStore: transientStore,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: "fp-memory-flush-narrowed",
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: ["Bash", "Edit"],
    });
    const forkCall = (
      client.request as unknown as { mock: { calls: [string, Record<string, unknown>][] } }
    ).mock.calls.find(([method]) => method === "thread/fork");
    expect(forkCall).toBeDefined();
    const forkParams = forkCall?.[1] as {
      dynamicTools?: { name: string }[];
      disallowedTools?: string[];
    };
    // Diversion must NOT widen the turn's tools — that was the policy-bypass
    // failure mode of suppressing the rotation instead of diverting it.
    expect(forkParams.dynamicTools?.map((t) => t.name)).toEqual(["read", "write"]);
    expect(forkParams.disallowedTools).toEqual(["Bash", "Edit"]);
  });

  it("still rotates the durable binding for a normal catalog change", async () => {
    await seedFullCatalogBinding();
    const result = await startOrResumeClaudeThread({
      client: makeClient({}),
      params: makeTriggerParams("user"),
      cfg: BASE_CFG,
      bridge: makeBridgeWithTools(["read", "write", "exec", "message"]),
      bindingStore: transientStore,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: "fp-genuinely-changed",
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    });
    expect(result.outcome).toBe("forked");
    expect(result.transient).toBeUndefined();
    expect((await transientStore.read(IDENTITY))?.threadId).toBe("thr_forked_001");
  });
});

// ── refresh-in-place instead of rotating (openclaw-djc6) ────────────────────

describe("startOrResumeClaudeThread — catalog drift refreshed in place", () => {
  let store2: ClaudeAppServerBindingStore;

  beforeEach(() => {
    store2 = createClaudeTestBindingStore();
  });

  async function seed() {
    await store2.write(IDENTITY, {
      threadId: "thr_live",
      cwd: "/tmp/ws",
      model: "claude-sonnet-4-6",
      approvalPolicy: BASE_CFG.appServer.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: BASE_CFG.appServer.sandbox,
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: STABLE_DYNAMIC_TOOLS_FP,
      dynamicToolsCount: 78,
    } as ClaudeAppServerBinding);
  }

  function args(client: ClaudeAppServerClient, fp: string) {
    return {
      client,
      params: makeParams(),
      cfg: BASE_CFG,
      bridge: makeBridge(),
      bindingStore: store2,
      developerInstructions: "x",
      developerInstructionsFingerprint: STABLE_DEVINSTRUCTIONS_FP,
      dynamicToolsFingerprint: fp,
      effectiveWorkspace: "/tmp/ws",
      nativeDisallowedTools: [],
    };
  }

  it("refreshes the live session and does NOT fork", async () => {
    await seed();
    const client = makeClient({
      refreshToolsResponse: { refreshed: true, added: ["openclaw"], removed: ["openclaw"] },
    });
    const result = await startOrResumeClaudeThread(args(client, "fp-drifted"));
    expect(result.outcome).toBe("refreshed");
    expect(result.threadId).toBe("thr_live"); // same thread — no rotation
    const methods = (client.request as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      ([m]) => m,
    );
    expect(methods).toContain("thread/refresh_tools");
    expect(methods).not.toContain("thread/fork");
  });

  it("records the new fingerprint against the SAME thread so the next turn sees no drift", async () => {
    // Without this the refresh is wasted: the binding would still look stale
    // and the very next turn would rotate anyway.
    await seed();
    const client = makeClient({ refreshToolsResponse: { refreshed: true } });
    await startOrResumeClaudeThread(args(client, "fp-drifted"));
    const binding = await store2.read(IDENTITY);
    expect(binding?.threadId).toBe("thr_live");
    expect(binding?.dynamicToolsFingerprint).toBe("fp-drifted");
  });

  it("falls back to forking when there is no live attempt to refresh", async () => {
    await seed();
    const client = makeClient({ refreshToolsResponse: { refreshed: false } });
    const result = await startOrResumeClaudeThread(args(client, "fp-drifted"));
    expect(result.outcome).toBe("forked");
    expect(result.threadId).toBe("thr_forked_001");
  });

  it("falls back to forking when the refresh RPC errors (e.g. older bridge)", async () => {
    // Must NOT proceed as though the policy change applied — an unsupported or
    // failed refresh has to rotate, or the model keeps the old tool surface.
    await seed();
    const client = makeClient({ refreshToolsError: new Error("Method not found") });
    const result = await startOrResumeClaudeThread(args(client, "fp-drifted"));
    expect(result.outcome).toBe("forked");
  });

  it("does not attempt a refresh when there is no drift", async () => {
    await seed();
    const client = makeClient({});
    const result = await startOrResumeClaudeThread(args(client, STABLE_DYNAMIC_TOOLS_FP));
    expect(result.outcome).toBe("resumed");
    const methods = (client.request as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      ([m]) => m,
    );
    expect(methods).not.toContain("thread/refresh_tools");
  });

  // ── version gate (openclaw-d42b) ──────────────────────────────────────────
  //
  // A bridge below MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH answers
  // `{ refreshed: true }` and THEN breaks the session: it forwards our
  // shape-only sdk server entry to Query.setMcpServers, which reads the absent
  // `instance` as "no longer desired", disconnects the in-process MCP transport,
  // and yet still tells the CLI the server exists. Every later
  // mcp__openclaw__* call fails `SDK MCP server not found: openclaw` for the
  // life of the attempt. The response is indistinguishable from a good one, so
  // the ONLY defense is to not ask an old bridge at all.

  it("does NOT ask a pre-fix bridge to refresh — it would answer true and wedge the session", async () => {
    await seed();
    const client = makeClient({
      bridgeVersion: "0.7.5",
      // Deliberately the pre-fix bridge's lie: it would claim success.
      refreshToolsResponse: { refreshed: true },
    });
    const result = await startOrResumeClaudeThread(args(client, "fp-drifted"));
    const methods = (client.request as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      ([m]) => m,
    );
    expect(methods).not.toContain("thread/refresh_tools");
    // Rotation is the correct, always-safe fallback.
    expect(result.outcome).toBe("forked");
    expect(result.threadId).toBe("thr_forked_001");
  });

  it("rotates rather than refreshing when the bridge version is unknown", async () => {
    await seed();
    const client = makeClient({
      bridgeVersion: undefined,
      refreshToolsResponse: { refreshed: true },
    });
    // makeClient defaults to the enabling floor, so null it out explicitly to
    // model a bridge that reported no version at initialize.
    (client as unknown as { getServerInfo: () => null }).getServerInfo = () => null;
    const result = await startOrResumeClaudeThread(args(client, "fp-drifted"));
    const methods = (client.request as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      ([m]) => m,
    );
    expect(methods).not.toContain("thread/refresh_tools");
    expect(result.outcome).toBe("forked");
  });

  it("refreshes on a bridge above the gate", async () => {
    await seed();
    const client = makeClient({
      bridgeVersion: "0.8.0",
      refreshToolsResponse: { refreshed: true },
    });
    const result = await startOrResumeClaudeThread(args(client, "fp-drifted"));
    expect(result.outcome).toBe("refreshed");
  });
});
