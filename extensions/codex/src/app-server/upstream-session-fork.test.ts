import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  forkControl,
  forkParams,
  forkResponse,
  codexForkTurn,
} from "./upstream-session-fork.test-support.js";

const boundaryMocks = vi.hoisted(() => ({
  listTurns: vi.fn(),
}));
const linkMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  upsert: vi.fn(),
}));
const transcriptMocks = vi.hoisted(() => ({
  importHistory: vi.fn(),
}));

const boundary = {
  beforeTurnId: "turn-2",
  targetTurnId: "turn-2",
  retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
} as const;

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLink: linkMocks.delete,
  upsertSessionUpstreamLink: linkMocks.upsert,
}));

vi.mock("./transcript-mirror.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transcript-mirror.js")>()),
  importCodexThreadHistoryToTranscript: transcriptMocks.importHistory,
}));

vi.mock("./upstream-fork-boundary.js", () => ({
  resolveCodexUpstreamForkBoundary: vi.fn(async () => ({
    ok: true,
    boundary,
    editorText: "edit me",
  })),
  listCodexUpstreamTurns: boundaryMocks.listTurns,
  precheckCodexUpstreamForkBoundary: vi.fn(() => ({ ok: true, boundary })),
}));

import { forkCodexUpstreamSession } from "./upstream-session-fork.js";

beforeEach(() => {
  boundaryMocks.listTurns.mockReset();
  linkMocks.delete.mockReset();
  linkMocks.upsert.mockReset().mockReturnValue(true);
  transcriptMocks.importHistory.mockReset().mockResolvedValue({
    importedMessages: 1,
    omittedMessages: 0,
  });
});

describe("forkCodexUpstreamSession", () => {
  it("verifies the original source cut, imports history, then links before binding", async () => {
    const sourceThreadId = "thread-source";
    const retainedTurn = codexForkTurn("turn-1", "one");
    boundaryMocks.listTurns
      .mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")])
      .mockResolvedValueOnce([retainedTurn]);
    const { archiveThread, control, controlFactory, forkThread } = forkControl();
    const events: string[] = [];
    linkMocks.upsert.mockImplementation(() => {
      events.push("link");
      return true;
    });
    const mutate = vi.fn(async () => {
      events.push("bind");
      return true;
    });
    const runtime = createPluginRuntimeMock();
    const createSessionEntry = vi.mocked(runtime.agent.session.createSessionEntry);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: {
        read: vi.fn(async () => undefined),
        mutate,
      } as unknown as CodexAppServerBindingStore,
      controlFactory,
      harnessRuntimeId: "codex-custom",
      resolveConfig: () => ({}),
      runtime,
    });

    expect(forkThread).toHaveBeenCalledWith({
      threadId: sourceThreadId,
      beforeTurnId: "turn-2",
      excludeTurns: true,
    });
    expect(boundaryMocks.listTurns).toHaveBeenLastCalledWith(control, "thread-forked");
    expect(transcriptMocks.importHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:forked",
        thread: expect.objectContaining({ id: "thread-forked", turns: [retainedTurn] }),
        throughTurnId: "turn-1",
      }),
    );
    expect(linkMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: { turnId: "turn-1", userMessageCount: 1 },
        sessionKey: "agent:main:dashboard:forked",
        threadId: "thread-forked",
      }),
    );
    expect(runtime.agent.session.createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({ agentHarnessId: "codex-custom" }),
      }),
    );
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("recoverMatchingInitialEntry");
    expect(events).toEqual(["link", "bind"]);
    expect(mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "set",
        binding: expect.objectContaining({
          connectionScope: "supervision",
          supervisionSourceThreadId: "thread-forked",
          preserveNativeModel: true,
          pendingSupervisionBranch: {
            sourceThreadId: "thread-forked",
            connectionFingerprint: "fingerprint",
            lastTurnId: "turn-1",
          },
        }),
      }),
    );
    expect(result).toEqual({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("requests a workspace sandbox when the fork creator requires isolation", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")])
      .mockResolvedValueOnce([codexForkTurn("turn-1", "one")]);
    const { controlFactory, forkThread } = forkControl();
    const requiredFork = { ...forkParams(), sandbox: "required" as const };

    const result = await forkCodexUpstreamSession(requiredFork, {
      bindingStore: {
        read: vi.fn(async () => undefined),
        mutate: vi.fn(async () => true),
      } as unknown as CodexAppServerBindingStore,
      controlFactory,
      harnessRuntimeId: "codex-custom",
      resolveConfig: () => ({}),
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "created" });
    expect(forkThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandbox: "workspace-write" }),
    );
  });

  it.each(["unknown home", "private connection drift", "private source drift"])(
    "fails closed on %s before reading or forking native history",
    async (scenario) => {
      const { controlFactory, forkThread } = forkControl();
      const params = forkParams();
      params.upstream.ref = {
        connectionFingerprint: scenario === "unknown home" ? "unknown-fingerprint" : "fingerprint",
        threadId: params.upstream.threadId,
      };

      await expect(
        forkCodexUpstreamSession(params, {
          bindingStore: {
            read: vi.fn(async () => ({
              threadId: "thread-canonical",
              connectionScope: "supervision",
              supervisionSourceThreadId:
                scenario === "private source drift" ? "other-source" : "thread-source",
              appServerRuntimeFingerprint:
                scenario === "private connection drift" ? "other-connection" : "fingerprint",
              preserveNativeModel: true,
              conversationSourceTransferComplete: true,
              cwd: "/tmp",
              model: "gpt-5.6-luna",
              modelProvider: "openai",
            })),
          } as unknown as CodexAppServerBindingStore,
          controlFactory,
          harnessRuntimeId: "codex",
          runtime: createPluginRuntimeMock(),
        }),
      ).resolves.toEqual({
        status: "failed",
        code: "upstream-unavailable",
        message:
          "This Codex thread is not available on the current connection. Reconnect to its host and try again.",
      });

      expect(forkThread).not.toHaveBeenCalled();
      expect(boundaryMocks.listTurns).not.toHaveBeenCalled();
    },
  );

  it("archives a fork whose read-back history proves beforeTurnId was ignored", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")])
      .mockResolvedValueOnce([codexForkTurn("turn-1", "one"), codexForkTurn("turn-2", "edit me")]);
    const { archiveThread, controlFactory } = forkControl();
    const runtime = createPluginRuntimeMock();

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: {
        read: vi.fn(async () => undefined),
        mutate: vi.fn(),
      } as unknown as CodexAppServerBindingStore,
      controlFactory,
      harnessRuntimeId: "codex",
      runtime,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "upstream-unavailable",
      message: expect.stringContaining("Codex version"),
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
    expect(runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
    expect(linkMocks.upsert).not.toHaveBeenCalled();
  });

  it("cleans the link and archives the fork when binding materialization fails", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")])
      .mockResolvedValueOnce([codexForkTurn("turn-1", "one")]);
    const { archiveThread, controlFactory } = forkControl();
    const mutate = vi.fn(async () => false);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: {
        read: vi.fn(async () => undefined),
        mutate,
      } as unknown as CodexAppServerBindingStore,
      controlFactory,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(linkMocks.delete).toHaveBeenCalledWith("agent:main:dashboard:forked", "main");
    expect(mutate).toHaveBeenCalledOnce();
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
  });

  it.each([
    "set threw before write",
    "set committed then threw",
    "finalization",
    "pending successor",
    "materialized successor",
  ])("compensates only its exact pending creation after %s fails", async (failure) => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")])
      .mockResolvedValueOnce([codexForkTurn("turn-1", "one")]);
    const { archiveThread, controlFactory } = forkControl();
    const bindingStore = createCodexTestBindingStore();
    const mutate = bindingStore.mutate.bind(bindingStore);
    if (failure === "set threw before write" || failure === "set committed then threw") {
      vi.spyOn(bindingStore, "mutate").mockImplementation(async (identity, mutation) => {
        if (mutation.kind === "set" && failure === "set threw before write") {
          throw new Error("Pre-write failure");
        }
        const result = await mutate(identity, mutation);
        if (mutation.kind === "set") {
          throw new Error("Post-write failure");
        }
        return result;
      });
    }
    const runtime = createPluginRuntimeMock();
    const createSession = vi.mocked(runtime.agent.session.createSessionEntry);
    const initialize = createSession.getMockImplementation()!;
    let createdIdentity: ReturnType<typeof sessionBindingIdentity> | undefined;
    let successor: Awaited<ReturnType<typeof bindingStore.read>>;
    createSession.mockImplementation(async (params) => {
      if (params.recoverMatchingInitialEntry) {
        throw new Error("Message forks must initialize a fresh child, not recover an existing one");
      }
      // Capture the callback's physical generation, including a post-write throw.
      const created = await initialize({
        ...params,
        afterCreate: async (entry) => {
          createdIdentity = sessionBindingIdentity({
            agentId: entry.agentId,
            sessionId: entry.sessionId,
            sessionKey: entry.key,
          });
          return await params.afterCreate?.(entry);
        },
      });
      const identity = createdIdentity!;
      const pending = (await bindingStore.read(identity))!.pendingSupervisionBranch!;
      if (failure === "pending successor") {
        await mutate(identity, {
          kind: "patch-pending-supervision-branch",
          expected: pending,
          pending: { ...pending, cleanupThreadIds: ["thread-successor-probe"] },
        });
      } else if (failure === "materialized successor") {
        await mutate(identity, {
          kind: "commit-pending-supervision-branch",
          expected: pending,
          threadId: "thread-successor-canonical",
          patch: { appServerRuntimeFingerprint: "fingerprint" },
        });
      }
      successor = await bindingStore.read(identity);
      expect(created.entry.modelSelectionLocked).toBe(true);
      throw new Error("Session finalization failed");
    });

    await expect(
      forkCodexUpstreamSession(forkParams(), {
        bindingStore,
        controlFactory,
        harnessRuntimeId: "codex",
        runtime,
      }),
    ).resolves.toMatchObject({ status: "failed", code: "upstream-unavailable" });

    const remaining = await bindingStore.read(createdIdentity!);
    if (failure === "pending successor" || failure === "materialized successor") {
      expect(remaining).toEqual(successor);
      expect(linkMocks.delete).not.toHaveBeenCalled();
      expect(archiveThread).not.toHaveBeenCalled();
    } else {
      expect(remaining).toBeUndefined();
      expect(linkMocks.delete).toHaveBeenCalledWith(forkParams().targetKey, "main");
      expect(archiveThread).toHaveBeenCalledExactlyOnceWith("thread-forked");
    }
    expect(createSession.mock.calls[0]?.[0].initialEntry.modelSelectionLocked).toBe(true);
  });

  it("archives a recoverable orphan id when the fork response is invalid", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")]);
    const { archiveThread, controlFactory } = forkControl(
      vi.fn(async () => ({ thread: { id: "thread-orphan" } })),
    );

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: { read: vi.fn(async () => undefined) } as unknown as CodexAppServerBindingStore,
      controlFactory,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).toHaveBeenCalledWith("thread-orphan");
  });

  it.each(["thread-source", "thread-canonical"])(
    "rejects a fork response that reuses the original or canonical source id: %s",
    async (threadId) => {
      boundaryMocks.listTurns.mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")]);
      const { archiveThread, controlFactory } = forkControl(
        vi.fn(async () => forkResponse(threadId)),
      );

      const result = await forkCodexUpstreamSession(forkParams(), {
        bindingStore: {
          read: vi.fn(async () => ({
            threadId: "thread-canonical",
            connectionScope: "supervision",
            supervisionSourceThreadId: "thread-source",
            appServerRuntimeFingerprint: "fingerprint",
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
            cwd: "/tmp",
            model: "gpt-5.6-luna",
            modelProvider: "openai",
          })),
          mutate: vi.fn(),
        } as unknown as CodexAppServerBindingStore,
        controlFactory,
        harnessRuntimeId: "codex",
        runtime: createPluginRuntimeMock(),
      });

      expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
      expect(archiveThread).not.toHaveBeenCalled();
    },
  );
});
