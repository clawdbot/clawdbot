import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  createForkTestRuntime,
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
  lastRetainedTurnId: "turn-1",
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

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fork-owner-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  boundaryMocks.listTurns.mockReset();
  linkMocks.delete.mockReset();
  linkMocks.upsert.mockReset().mockReturnValue(true);
  transcriptMocks.importHistory.mockReset().mockResolvedValue({
    importedMessages: 1,
    omittedMessages: 0,
  });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
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
    const bindingStore = createCodexTestBindingStore();
    const write = bindingStore.mutate.bind(bindingStore);
    const mutate = vi.spyOn(bindingStore, "mutate").mockImplementation(async (...args) => {
      events.push("bind");
      return await write(...args);
    });
    const runtime = createForkTestRuntime(undefined, bindingStore, "codex-custom");
    const createSessionEntry = vi.mocked(runtime.agent.session.createSessionEntry);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore,
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
      expect.objectContaining({ ifAbsent: true }),
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
      expect.any(Function),
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
    const bindingStore = createCodexTestBindingStore();
    const runtime = createForkTestRuntime(undefined, bindingStore, "codex-custom");
    const requiredFork = { ...forkParams(), sandbox: "required" as const };

    const result = await forkCodexUpstreamSession(requiredFork, {
      bindingStore,
      controlFactory,
      harnessRuntimeId: "codex-custom",
      resolveConfig: () => ({}),
      runtime,
    });

    expect(result).toEqual({
      status: "created",
      key: forkParams().targetKey,
      editorText: "edit me",
    });
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
            read: vi.fn(() => ({
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
      bindingStore: createCodexTestBindingStore(),
      controlFactory,
      harnessRuntimeId: "codex",
      runtime,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "upstream-unavailable",
      message: expect.stringContaining("Codex version"),
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked", undefined);
    expect(runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
    expect(linkMocks.upsert).not.toHaveBeenCalled();
  });

  it("leaves unverified orphan ids unowned when the fork response is invalid", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([codexForkTurn("turn-2", "edit me")]);
    const { archiveThread, controlFactory } = forkControl(
      vi.fn(async () => ({ thread: { id: "thread-orphan" } })),
    );

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: { read: vi.fn(() => undefined) } as unknown as CodexAppServerBindingStore,
      controlFactory,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).not.toHaveBeenCalled();
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
          read: vi.fn(() => ({
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
