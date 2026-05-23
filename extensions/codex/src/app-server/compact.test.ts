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

async function writeTestBinding(options: { authProfileId?: string } = {}): Promise<string> {
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

  it("waits for native app-server compaction before reporting success", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });

    let settled = false;
    void pendingResult.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

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
            total_tokens: 27_170,
          },
        },
      },
    });
    const result = requireCompactResult(await pendingResult);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensBefore).toBe(123);
    expect(result.result?.tokensAfter).toBe(27_170);
    const details = compactDetails(result);
    expect(details.backend).toBe("codex-app-server");
    expect(details.threadId).toBe("thread-1");
    expect(details.signal).toBe("thread/compacted");
    expect(details.turnId).toBe("turn-1");
    expect(details.tokenUsageSource).toBe("thread/tokenUsage/updated");
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

  it("uses native token usage that arrives before compaction completion", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });

    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last_token_usage: {
            total_tokens: 18_004,
          },
        },
      },
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    const result = requireCompactResult(await pendingResult);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensAfter).toBe(18_004);
    expect(compactDetails(result).tokenUsageSource).toBe("thread/tokenUsage/updated");
  });

  it("accepts native current token usage with a total alias", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });

    fake.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last: {
            total: 16_384,
          },
        },
      },
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    const result = requireCompactResult(await pendingResult);

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensAfter).toBe(16_384);
    expect(compactDetails(result).tokenUsageSource).toBe("thread/tokenUsage/updated");
  });

  it("accepts native context-compaction item completion with unknown token count as success", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "compact-1" },
      },
    });

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensAfter).toBeUndefined();
    const details = compactDetails(result);
    expect(details.signal).toBe("item/completed");
    expect(details.itemId).toBe("compact-1");
  });

  it("does not treat zero native token usage as an authoritative post-compaction count", async () => {
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = startCompaction(sessionFile, { currentTokenCount: 123 });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
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

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.tokensAfter).toBeUndefined();
    expect(compactDetails(result).tokenUsageSource).toBeUndefined();
  });

  it("reuses the bound auth profile for native compaction", async () => {
    const fake = createFakeCodexClient();
    let seenAuthProfileId: string | undefined;
    setCodexAppServerClientFactoryForTest(async (_startOptions, authProfileId) => {
      seenAuthProfileId = authProfileId;
      return fake.client;
    });
    const sessionFile = await writeTestBinding({ authProfileId: "openai-codex:work" });

    const pendingResult = startCompaction(sessionFile);
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(seenAuthProfileId).toBe("openai-codex:work");
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

  it("clears stale thread bindings and reports failed native compaction", async () => {
    const fake = createFakeCodexClient();
    fake.request.mockRejectedValueOnce(new Error("thread not found: thread-1"));
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const result = requireCompactResult(
      await startCompaction(sessionFile, { currentTokenCount: 456 }),
    );

    expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("thread not found: thread-1");
    expect(result.failure?.reason).toBe("stale_thread_binding");
    expect(result.result).toBeUndefined();
  });

  it("restarts the Codex app-server and retries when native compaction times out", async () => {
    const previousTimeout = process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS;
    process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS = "100";
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    try {
      const first = createFakeCodexClient();
      const second = createFakeCodexClient();
      let factoryCalls = 0;
      const factory = vi.fn(async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return first.client;
        }
        return second.client;
      });
      setCodexAppServerClientFactoryForTest(factory);
      const sessionFile = await writeTestBinding();

      const pendingResult = startCompaction(sessionFile, { currentTokenCount: 456 });
      await vi.waitFor(() => {
        expect(first.request).toHaveBeenCalledWith("thread/compact/start", {
          threadId: "thread-1",
        });
      });

      await vi.waitFor(() => {
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(second.request).toHaveBeenCalledWith("thread/compact/start", {
          threadId: "thread-1",
        });
      });
      second.emit({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: {
            last_token_usage: {
              total_tokens: 12_345,
            },
          },
        },
      });
      second.emit({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-2",
          item: { type: "contextCompaction", id: "compact-2" },
        },
      });

      const result = requireCompactResult(await pendingResult);
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(true);
      expect(result.result?.tokensAfter).toBe(12_345);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(second.close).not.toHaveBeenCalled();
      expect(await readCodexAppServerBinding(sessionFile)).toBeDefined();
      const details = compactDetails(result);
      expect(details.signal).toBe("item/completed");
      expect(details.itemId).toBe("compact-2");
      expect(details.compactionAttempts).toBe(2);
      expect(details.recoveredAfterAppServerRestart).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "codex app-server compaction timed out; restarting app-server",
        expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          threadId: "thread-1",
          attempt: 1,
          maxAttempts: 2,
        }),
      );
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS = previousTimeout;
      }
      warn.mockRestore();
    }
  });

  it("warns when stale OpenClaw compaction overrides are ignored", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession({
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
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

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

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
      sessionFile,
      workspaceDir: tempDir,
      config: {
        agents: {
          list: [
            {
              id: "nik",
              compaction: {
                model: "openai/gpt-5.4-mini",
                provider: "openai",
              },
            },
          ],
        },
      },
    });
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

    expect(warn).toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      {
        sessionId: "session-1",
        sessionKey: "agent:nik:session-1",
        ignoredConfig: ["agents.list.nik.compaction.model", "agents.list.nik.compaction.provider"],
      },
    );
    warn.mockRestore();
  });

  it("reports inherited compaction providers at the source path", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const fake = createFakeCodexClient();
    setCodexAppServerClientFactoryForTest(async () => fake.client);
    const sessionFile = await writeTestBinding();

    const pendingResult = maybeCompactCodexAppServerSession({
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
    await vi.waitFor(() => {
      expect(fake.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "thread-1" });
    });
    fake.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    await pendingResult;

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

  it("does not warn for legacy Lossless config when the Lossless context engine slot is active", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const sessionFile = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({ ok: true, compacted: false, reason: "below threshold" })),
    };

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
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
              model: "openai/gpt-5.4",
              provider: "lossless-claw",
            },
          },
        },
      },
    });

    expect(warn).not.toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("does not warn for inherited legacy Lossless provider when the Lossless slot is active", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const sessionFile = await writeTestBinding();
    const contextEngine: ContextEngine = {
      info: { id: "lcm", name: "Lossless Context Manager", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({ ok: true, compacted: false, reason: "below threshold" })),
    };

    await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:nik:session-1",
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
              id: "nik",
              compaction: {
                model: "openai/gpt-5.4-mini",
              },
            },
          ],
        },
      },
    });

    expect(warn).not.toHaveBeenCalledWith(
      "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
      expect.anything(),
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

  it("runs owning context-engine compaction and invalidates the Codex thread binding", async () => {
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 55,
        details: { engine: "lossless-claw" },
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

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      contextEngine,
      contextTokenBudget: 777,
      contextEngineRuntimeContext: { workspaceDir: tempDir, provider: "codex" },
      currentTokenCount: 123,
      trigger: "manual",
    });

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("engine summary");
    expect(result.result?.firstKeptEntryId).toBe("entry-1");
    expect(result.result?.tokensBefore).toBe(55);
    const details = compactDetails(result);
    expect(details.engine).toBe("lossless-claw");
    expect(details.codexThreadBindingInvalidated).toBe(true);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        tokenBudget: 777,
        currentTokenCount: 123,
        compactionTarget: "threshold",
        customInstructions: undefined,
        force: true,
        runtimeContext: { workspaceDir: tempDir, provider: "codex" },
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(maintain).toHaveBeenCalledTimes(1);
    const [maintainCall] = maintain.mock.calls[0] ?? [];
    const maintainParams = maintainCall as
      | {
          sessionId?: string;
          sessionKey?: string;
          sessionFile?: string;
          runtimeContext?: { workspaceDir?: string; provider?: string };
        }
      | undefined;
    expect(maintainParams?.sessionId).toBe("session-1");
    expect(maintainParams?.sessionKey).toBe("agent:main:session-1");
    expect(maintainParams?.sessionFile).toBe(sessionFile);
    expect(maintainParams?.runtimeContext?.workspaceDir).toBe(tempDir);
    expect(maintainParams?.runtimeContext?.provider).toBe("codex");
    expect(info).toHaveBeenCalledWith(
      "starting context-engine-owned Codex app-server compaction",
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        engineId: "lossless-claw",
        tokenBudget: 777,
        currentTokenCount: 123,
        trigger: "manual",
        compactionTarget: "threshold",
        force: true,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "completed context-engine-owned Codex app-server compaction",
      expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        engineId: "lossless-claw",
        ok: true,
        compacted: true,
        codexThreadBindingInvalidated: true,
      }),
    );
  });

  it("honors explicit force for budget-triggered owning context-engine compaction", async () => {
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 900,
        tokensAfter: 100,
      },
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
    };

    const result = requireCompactResult(
      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        contextEngine,
        contextTokenBudget: 777,
        currentTokenCount: 900,
        trigger: "budget",
        force: true,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(compact).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionTarget: "budget",
        force: true,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "starting context-engine-owned Codex app-server compaction",
      expect.objectContaining({
        trigger: "budget",
        compactionTarget: "budget",
        force: true,
      }),
    );
  });

  it("adopts successor transcript handles after owning context-engine compaction", async () => {
    const sessionFile = await writeTestBinding();
    const successorFile = path.join(tempDir, "session.compacted.jsonl");
    await writeCodexAppServerBinding(successorFile, {
      threadId: "thread-successor",
      cwd: tempDir,
    });
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 55,
        sessionId: "session-1-compacted",
        sessionFile: successorFile,
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
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.sessionId).toBe("session-1-compacted");
    expect(result.result?.sessionFile).toBe(successorFile);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
    expect(await readCodexAppServerBinding(successorFile)).toBeUndefined();
    expect(maintain).toHaveBeenCalledTimes(1);
    const [maintainCall] = maintain.mock.calls[0] ?? [];
    const maintainParams = maintainCall as
      | {
          sessionId?: string;
          sessionFile?: string;
        }
      | undefined;
    expect(maintainParams?.sessionId).toBe("session-1-compacted");
    expect(maintainParams?.sessionFile).toBe(successorFile);
  });

  it("returns context-engine compaction success when maintenance fails", async () => {
    const sessionFile = await writeTestBinding();
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 55,
      },
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain: vi.fn(async () => {
        throw new Error("maintenance boom");
      }),
    };

    const pendingResult = maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile,
      workspaceDir: tempDir,
      contextEngine,
    });

    const result = requireCompactResult(await pendingResult);
    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("engine summary");
    const details = compactDetails(result);
    expect(details.codexThreadBindingInvalidated).toBe(true);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("does not require a Codex binding when the owning context engine compacts", async () => {
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "engine summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 8,
      },
    }));
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact,
      maintain,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
    });

    const compactResult = requireCompactResult(result);
    expect(compactResult.ok).toBe(true);
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.result?.summary).toBe("engine summary");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("does not run context-engine maintenance when owning compaction does not compact", async () => {
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const contextEngine: ContextEngine = {
      info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
      assemble: vi.fn() as never,
      ingest: vi.fn() as never,
      compact: vi.fn(async () => ({
        ok: true,
        compacted: false,
        reason: "below threshold",
      })),
      maintain,
    };

    const result = await maybeCompactCodexAppServerSession({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: path.join(tempDir, "missing-binding.jsonl"),
      workspaceDir: tempDir,
      contextEngine,
    });

    const compactResult = requireCompactResult(result);
    expect(compactResult.ok).toBe(true);
    expect(compactResult.compacted).toBe(false);
    expect(compactResult.reason).toBe("below threshold");
    expect(maintain).not.toHaveBeenCalled();
  });

  describe("owning context-engine compaction safety timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("bounds a hung owning context-engine compact() and reports a clean ok:false", async () => {
      const sessionFile = await writeTestBinding();
      const compact = vi.fn<ContextEngine["compact"]>(() => new Promise(() => {}));
      const contextEngine: ContextEngine = {
        info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
        assemble: vi.fn() as never,
        ingest: vi.fn() as never,
        compact,
      };

      vi.useFakeTimers();
      const pendingResult = maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        contextEngine,
        // 1 s host-resolved compaction timeout.
        config: { agents: { defaults: { compaction: { timeoutSeconds: 1 } } } },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = requireCompactResult(await pendingResult);

      expect(result.ok).toBe(false);
      expect(result.compacted).toBe(false);
      expect(result.reason).toContain("timed out");
      expect(compact).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("threads a composed caller abort signal into the owning context-engine compact()", async () => {
      const sessionFile = await writeTestBinding();
      const controller = new AbortController();
      const compact = vi.fn<ContextEngine["compact"]>(async () => ({
        ok: true,
        compacted: false,
        reason: "below threshold",
      }));
      const contextEngine: ContextEngine = {
        info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
        assemble: vi.fn() as never,
        ingest: vi.fn() as never,
        compact,
      };

      await maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        contextEngine,
        abortSignal: controller.signal,
      });

      expect(compact).toHaveBeenCalledTimes(1);
      expect(compact.mock.calls[0]?.[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it("aborts a hung owning context-engine compact() when the caller signal fires", async () => {
      const sessionFile = await writeTestBinding();
      const controller = new AbortController();
      const compact = vi.fn<ContextEngine["compact"]>(() => new Promise(() => {}));
      const contextEngine: ContextEngine = {
        info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
        assemble: vi.fn() as never,
        ingest: vi.fn() as never,
        compact,
      };

      const pendingResult = maybeCompactCodexAppServerSession({
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        sessionFile,
        workspaceDir: tempDir,
        contextEngine,
        abortSignal: controller.signal,
      });

      controller.abort(new Error("run aborted"));
      const result = requireCompactResult(await pendingResult);

      expect(result.ok).toBe(false);
      expect(result.compacted).toBe(false);
      expect(result.reason).toContain("run aborted");
      expect(compact).toHaveBeenCalledTimes(1);
    });
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
  return {
    client: {
      request,
      close,
      addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
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
