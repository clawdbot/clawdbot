import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexAppServerClient } from "./client.js";
import { maybeCompactCodexAppServerSession as maybeCompactCodexAppServerSessionImpl } from "./compact.js";
import type { CodexServerNotification } from "./protocol.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";

let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;

type MaybeCompactOptions = NonNullable<Parameters<typeof maybeCompactCodexAppServerSessionImpl>[1]>;

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
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  return maybeCompactCodexAppServerSessionImpl(
    params,
    clientFactory ? { ...options, clientFactory } : options,
  );
}

async function writeTestBinding(
  options: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
): Promise<string> {
  const sessionFile = path.join(tempDir, "session.jsonl");
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-1",
    cwd: tempDir,
    ...options,
  });
  return sessionFile;
}

function startCompaction(sessionFile: string, options: { currentTokenCount?: number } = {}) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    ...options,
  });
}

function startSandboxedCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  });
}

function startNodeExecCompaction(sessionFile: string) {
  return maybeCompactCodexAppServerSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir: tempDir,
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

describe("maybeCompactCodexAppServerSession", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-compact-"));
  });

  afterEach(async () => {
    resetCodexAppServerClientFactoryForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("starts native app-server compaction without waiting for completion", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(fake.client.addNotificationHandler).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.result?.tokensBefore).toBe(123);
    expect(result.result?.tokensAfter).toBeUndefined();
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(details.signal).toBe("thread/compact/start");
    expect(details.pending).toBe(true);
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

  it("does not consume native completion notifications after forwarding the request", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 123 }),
    );
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last_token_usage: {
            total_tokens: 0,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.result?.tokensAfter).toBeUndefined();
    expect(compactDetails(result).tokenUsageSource).toBeUndefined();
    expect(compactDetails(result).signal).toBe("thread/compact/start");
  });

  it("reuses the bound auth profile for native compaction", async () => {
    const fake = createFakeCodexClient();
    let seenAuthProfileId: string | undefined;
    setCodexAppServerClientFactoryForTest(async (_startOptions, authProfileId) => {
      seenAuthProfileId = authProfileId;
      return fake.client;
    });
    const sessionFile = await writeTestBinding({ authProfileId: "openai-codex:work" });

    const result = requireCompactResult(await startCompaction(sessionFile));

    expect(seenAuthProfileId).toBe("openai-codex:work");
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
    fake.request.mockRejectedValueOnce(new Error("thread not found: thread-1"));
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding({
      authProfileId: "openai-codex:work",
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
    expect(preservedBinding?.authProfileId).toBe("openai-codex:work");
    expect(preservedBinding?.model).toBe("gpt-5.5-mini");
    expect(preservedBinding?.approvalPolicy).toBe("on-request");
    expect(preservedBinding?.sandbox).toBe("workspace-write");
    expect(preservedBinding?.serviceTier).toBe("priority");
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("thread not found: thread-1");
    expect(result.failure?.reason).toBe("stale_thread_binding");
    expect(result.result).toBeUndefined();
  });

  it("does not impose an OpenClaw timeout after Codex accepts native compaction", async () => {
    const fake = createFakeCodexClient();
    const factory = vi.fn(async () => fake.client);
    setCodexAppServerClientFactoryForTest(factory);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: true,
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
    const sessionFile = await writeTestBinding();

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:sara:session-1",
      sessionFile,
      workspaceDir: tempDir,
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
    const sessionFile = await writeTestBinding();

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
      sessionFile,
      workspaceDir: tempDir,
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
    const sessionFile = await writeTestBinding();
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
    const sessionFile = await writeTestBinding();
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
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "openai-codex:binding",
    });

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      authProfileId: "openai-codex:runtime",
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
    expect(result.compacted).toBe(false);
    expect(compactDetails(result)).toMatchObject({
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: true,
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

function createFakeCodexClient(): {
  client: CodexAppServerClient;
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit: (notification: CodexServerNotification) => void;
} {
  const handlers = new Set<(notification: CodexServerNotification) => void>();
  const request = vi.fn(async () => ({}));
  const close = vi.fn();
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
      addNotificationHandler,
    } as unknown as CodexAppServerClient,
    request,
    close,
    emit(notification: CodexServerNotification): void {
      for (const handler of handlers) {
        handler(notification);
      }
    },
  };
}
