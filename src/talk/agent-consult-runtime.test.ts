import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "./agent-consult-tool.js";
import {
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
} from "./agent-consult-tool.js";

type ForkSessionEntryFromParent =
  typeof import("../auto-reply/reply/session-fork.js").forkSessionEntryFromParent;
type ForkSessionEntryFromParentParams = Parameters<ForkSessionEntryFromParent>[0];
type ForkSessionEntryFromParentResult = Awaited<ReturnType<ForkSessionEntryFromParent>>;

const sessionForkMocks = vi.hoisted(() => ({
  defaultForkSessionEntryFromParent: undefined as ForkSessionEntryFromParent | undefined,
  forkSessionEntryFromParent: vi.fn(),
}));

vi.mock("../auto-reply/reply/session-fork.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/reply/session-fork.js")>();
  sessionForkMocks.defaultForkSessionEntryFromParent = actual.forkSessionEntryFromParent;
  sessionForkMocks.forkSessionEntryFromParent.mockImplementation(actual.forkSessionEntryFromParent);
  return {
    ...actual,
    forkSessionEntryFromParent: sessionForkMocks.forkSessionEntryFromParent,
  };
});

let testTempDir: string | undefined;

function testTempPath(name: string): string {
  if (!testTempDir) {
    throw new Error("Expected an isolated consult runtime test directory");
  }
  return path.join(testTempDir, name);
}

function createAgentRuntime(payloads: unknown[] = [{ text: "Speak this." }]) {
  const sessionStore: Record<
    string,
    {
      sessionId?: string;
      updatedAt?: number;
      createdVia?: SessionEntry["createdVia"];
      createdActor?: SessionEntry["createdActor"];
      createdAt?: number;
      archivedAt?: number;
      sessionFile?: string;
      spawnedBy?: string;
      agentHarnessId?: string;
      modelSelectionLocked?: boolean;
      forkedFromParent?: boolean;
      totalTokens?: number;
      delivery?: SessionEntry["delivery"];
    }
  > = {};
  const runEmbeddedAgent = vi.fn(async () => ({
    payloads,
    meta: {},
  }));
  const updateSessionStore = vi.fn(
    async (
      _storePath: string,
      mutator: (store: Record<string, { sessionId?: string; updatedAt?: number }>) => unknown,
    ) => {
      return await mutator(sessionStore);
    },
  );
  const getSessionEntry = vi.fn(
    (params: { sessionKey: string }) => sessionStore[params.sessionKey],
  );
  const patchSessionEntry = vi.fn(
    async (params: {
      sessionKey: string;
      fallbackEntry?: Record<string, unknown>;
      update: (
        entry: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
    }) => {
      const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
      if (!existing) {
        return null;
      }
      const patch = await params.update({ ...existing });
      if (!patch) {
        return existing;
      }
      const next = { ...existing, ...patch };
      sessionStore[params.sessionKey] = next;
      return next;
    },
  );
  const upsertSessionEntry = vi.fn(
    async (params: { sessionKey: string; entry: Record<string, unknown> }) => {
      sessionStore[params.sessionKey] = { ...params.entry };
    },
  );
  return {
    runtime: {
      resolveAgentDir: vi.fn(() => testTempPath("agent")),
      resolveAgentWorkspaceDir: vi.fn(() => testTempPath("workspace")),
      ensureAgentWorkspace: vi.fn(async () => {}),
      resolveAgentTimeoutMs: vi.fn(() => 30_000),
      session: {
        resolveStorePath: vi.fn(() => testTempPath("sessions.json")),
        loadSessionStore: vi.fn(() => sessionStore),
        saveSessionStore: vi.fn(async () => {}),
        updateSessionStore,
        getSessionEntry,
        patchSessionEntry,
        upsertSessionEntry,
        resolveSessionFilePath: vi.fn(
          (_sessionId: string, entry?: { sessionFile?: string }) =>
            entry?.sessionFile ?? testTempPath("session.json"),
        ),
      },
      runEmbeddedAgent,
    },
    runEmbeddedAgent,
    sessionStore,
  };
}

function requireEmbeddedAgentCall(runEmbeddedAgent: {
  mock: { calls: unknown[][] };
}): RunEmbeddedAgentParams {
  const [call] = runEmbeddedAgent.mock.calls;
  if (!call) {
    throw new Error("Expected embedded OpenClaw agent call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return params as RunEmbeddedAgentParams;
}

function expectPositiveTimestamp(value: unknown) {
  expect(typeof value).toBe("number");
  expect(value as number).toBeGreaterThan(0);
}

function expectNonEmptyString(value: unknown) {
  expect(typeof value).toBe("string");
  expect((value as string).trim()).not.toBe("");
}

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("realtime voice agent consult runtime", () => {
  beforeEach(async () => {
    // macOS aliases its temp directory through /var; canonical paths keep the
    // SQLite cache key and cleanup target aligned.
    testTempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-consult-")),
    );
  });

  afterEach(async () => {
    sessionForkMocks.forkSessionEntryFromParent.mockReset();
    const defaultForkSessionEntryFromParent = sessionForkMocks.defaultForkSessionEntryFromParent;
    if (!defaultForkSessionEntryFromParent) {
      throw new Error("Expected the realtime voice session fork implementation");
    }
    sessionForkMocks.forkSessionEntryFromParent.mockImplementation(
      defaultForkSessionEntryFromParent,
    );
    const tempDir = testTempDir;
    testTempDir = undefined;
    if (tempDir) {
      closeOpenClawAgentDatabaseByPath(path.join(tempDir, "openclaw-agent.sqlite"));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exposes the shared consult tool based on policy", () => {
    expect(resolveRealtimeVoiceAgentConsultTools("safe-read-only")).toStrictEqual([
      REALTIME_VOICE_AGENT_CONSULT_TOOL,
    ]);
    expect(resolveRealtimeVoiceAgentConsultTools("none")).toStrictEqual([]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("safe-read-only")).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("owner")).toBeUndefined();
    expect(resolveRealtimeVoiceAgentConsultToolsAllow("none")).toStrictEqual([]);
  });

  it("runs an embedded agent using the shared session and prompt contract", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();

    const result = await consultRealtimeVoiceAgent({
      cfg: { agents: { list: [{ id: "operator", default: true }] } } as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?", context: "Caller asked about PR #123." },
      transcript: [{ role: "user", text: "Can you check this?" }],
      surface: "a live phone call",
      userLabel: "Caller",
      questionSourceLabel: "caller",
      toolsAllow: ["read"],
      provider: "openai",
      model: "gpt-5.4",
      thinkLevel: "high",
      fastMode: true,
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "Speak this." });
    const voiceSession = sessionStore["voice:15550001234"];
    if (!voiceSession) {
      throw new Error("Expected voice consult session entry");
    }
    expect(Object.keys(voiceSession).toSorted()).toStrictEqual([
      "createdAt",
      "createdVia",
      "sessionId",
      "updatedAt",
    ]);
    expect(voiceSession.createdVia).toBe("talk");
    expectPositiveTimestamp(voiceSession.createdAt);
    expectNonEmptyString(voiceSession.sessionId);
    expectPositiveTimestamp(voiceSession.updatedAt);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe(voiceSession.sessionId);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:operator:voice:15550001234");
    expect(call.agentId).toBe("operator");
    expect(call.messageProvider).toBe("voice");
    expect(call.lane).toBe("voice");
    expect(call.toolsAllow).toStrictEqual(["read"]);
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-5.4");
    expect(call.thinkLevel).toBe("high");
    expect(call.fastMode).toBe(true);
    expect(call.timeoutMs).toBe(10_000);
    expect(call.prompt).toBe(
      [
        "Live voice request from the caller during a live phone call.",
        "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
        "When finished, return only the concise result the realtime voice agent should speak back.",
        "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
        "Recent voice transcript for context:\nCaller: Can you check this?",
        "Additional realtime context:\nCaller asked about PR #123.",
        "User request:\nWhat should I say?",
      ].join("\n\n"),
    );
    expect(call.extraSystemPrompt).toBe(
      "You are the configured OpenClaw agent receiving delegated requests from a live voice bridge. Act on behalf of the user, use available tools when appropriate, and return a brief speakable result.",
    );
  });

  it("rejects an archived consult session before mutating or starting work", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:archived"] = {
      sessionId: "archived-session",
      updatedAt: 1,
      archivedAt: 2,
    };

    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:archived",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-realtime-consult:archived",
        args: { question: "What should I say?" },
        transcript: [],
        surface: "a live phone call",
        userLabel: "Caller",
      }),
    ).rejects.toThrow('Session "voice:archived" is archived. Restore it before starting new work.');
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("fails closed before dispatching a model for a locked Codex consult session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:locked"] = {
      sessionId: "locked-session",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };

    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "voice:locked",
        messageProvider: "voice",
        lane: "voice",
        runIdPrefix: "voice-realtime-consult:locked",
        args: { question: "Continue this session." },
        transcript: [],
        surface: "a live phone call",
        userLabel: "Caller",
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("fails closed before forking or dispatching from a locked requester session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "locked-requester",
      updatedAt: 1,
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    };
    const forkSessionEntryFromParent = sessionForkMocks.forkSessionEntryFromParent;

    await expect(
      consultRealtimeVoiceAgent({
        cfg: {} as never,
        agentRuntime: runtime as never,
        logger: { warn: vi.fn() },
        sessionKey: "agent:main:subagent:google-meet:meet-locked",
        spawnedBy: "agent:main:main",
        contextMode: "fork",
        messageProvider: "google-meet",
        lane: "google-meet",
        runIdPrefix: "google-meet:meet-locked",
        args: { question: "Continue this session." },
        transcript: [],
        surface: "a private Google Meet",
        userLabel: "Participant",
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(forkSessionEntryFromParent).not.toHaveBeenCalled();
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("fresh-checks archive state after a queued lifecycle mutation", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    const sessionKey = "voice:archive-race";
    sessionStore[sessionKey] = {
      sessionId: "active-session",
      updatedAt: 1,
    };
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: testTempPath("sessions.json"),
      identities: [sessionKey, "active-session"],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        const entry = sessionStore[sessionKey];
        if (entry) {
          entry.archivedAt = 2;
        }
      },
    });
    await mutationStarted.promise;

    const consult = consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      sessionKey,
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:archive-race",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });
    await Promise.resolve();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await mutation;
    await expect(consult).rejects.toThrow(
      'Session "voice:archive-race" is archived. Restore it before starting new work.',
    );
    expect(runtime.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("scopes sandbox resolution to the configured consult agent", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();

    await consultRealtimeVoiceAgent({
      cfg: { agents: { list: [{ id: "operator", default: true }] } } as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "voice",
      sessionKey: "voice:15550001234",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionKey).toBe("voice:15550001234");
    expect(call.sandboxSessionKey).toBe("agent:voice:voice:15550001234");
    expect(call.agentId).toBe("voice");
  });

  it("returns a speakable fallback when the embedded agent has no visible text", async () => {
    const warn = vi.fn();
    const { runtime } = createAgentRuntime([{ text: "hidden", isReasoning: true }]);

    const result = await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn },
      sessionKey: "google-meet:meet-1",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What now?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
      fallbackText: "Let me verify that first.",
    });

    expect(result).toEqual({ text: "Let me verify that first." });
    expect(warn).toHaveBeenCalledWith(
      "[talk] agent consult produced no answer: agent returned no speakable text",
    );
  });

  it("forks requester context when fork mode has a parent session", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:main"] = {
      sessionId: "parent-session",
      sessionFile: testTempPath("parent.jsonl"),
      totalTokens: 100,
      updatedAt: 1,
    };
    const resolveParentForkDecision = vi.fn(async () => ({
      status: "fork" as const,
      maxTokens: 100_000,
      parentTokens: 100,
    }));
    const forkSessionEntryFromParent = sessionForkMocks.forkSessionEntryFromParent;
    forkSessionEntryFromParent.mockImplementation(
      async (
        params: ForkSessionEntryFromParentParams,
      ): Promise<ForkSessionEntryFromParentResult> => {
        const fork = {
          sessionId: "forked-session",
          sessionFile: testTempPath("forked.jsonl"),
        };
        const parentEntry = sessionStore["agent:main:main"];
        if (!parentEntry?.sessionId) {
          return { status: "missing-parent" };
        }
        const typedParentEntry: SessionEntry = {
          ...parentEntry,
          sessionId: parentEntry.sessionId,
          updatedAt: parentEntry.updatedAt ?? Date.now(),
        };
        const decision = {
          status: "fork" as const,
          maxTokens: 100_000,
        };
        const entry = params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() };
        const sessionEntry: SessionEntry = {
          ...entry,
          ...params.patch?.({ entry, parentEntry: typedParentEntry, fork, decision }),
          sessionId: fork.sessionId,
          sessionFile: fork.sessionFile,
          forkedFromParent: true,
        };
        sessionStore[params.sessionKey] = sessionEntry;
        return {
          status: "forked" as const,
          fork,
          parentEntry: typedParentEntry,
          sessionEntry,
          decision,
        };
      },
    );

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(resolveParentForkDecision).not.toHaveBeenCalled();
    expect(forkSessionEntryFromParent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:main",
        agentId: "main",
        config: {},
        sessionKey: "agent:main:subagent:google-meet:meet-1",
      }),
    );
    expect(runtime.session.patchSessionEntry).not.toHaveBeenCalled();
    const forkedEntry = sessionStore["agent:main:subagent:google-meet:meet-1"];
    if (!forkedEntry) {
      throw new Error("Expected forked consult session entry");
    }
    expect(forkedEntry).toStrictEqual({
      sessionId: "forked-session",
      sessionFile: testTempPath("forked.jsonl"),
      spawnedBy: "agent:main:main",
      forkedFromParent: true,
      createdVia: "talk",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: forkedEntry.createdAt,
      updatedAt: forkedEntry.updatedAt,
    });
    expectPositiveTimestamp(forkedEntry.updatedAt);
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("forked-session");
    expect(call.sessionFile).toBeUndefined();
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: "forked-session",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      storePath: testTempPath("sessions.json"),
    });
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("falls back to a fresh isolated consult session when requester context is too large", async () => {
    const { runtime, runEmbeddedAgent } = createAgentRuntime();
    const warn = vi.fn();
    const forkSessionEntryFromParent = sessionForkMocks.forkSessionEntryFromParent;
    forkSessionEntryFromParent.mockImplementation(
      async (
        params: ForkSessionEntryFromParentParams,
      ): Promise<ForkSessionEntryFromParentResult> => ({
        status: "skipped",
        reason: "decision-skip",
        sessionEntry: {
          ...(params.fallbackEntry ?? { sessionId: "", updatedAt: Date.now() }),
          sessionId: "",
          updatedAt: Date.now(),
        },
        decision: {
          status: "skip",
          reason: "parent-too-large",
          maxTokens: 100_000,
          parentTokens: 150_000,
          message:
            "Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
        },
      }),
    );

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn },
      agentId: "main",
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      spawnedBy: "agent:main:main",
      contextMode: "fork",
      messageProvider: "google-meet",
      lane: "google-meet",
      runIdPrefix: "google-meet:meet-1",
      args: { question: "What should I say?" },
      transcript: [],
      surface: "a private Google Meet",
      userLabel: "Participant",
    });

    expect(warn).toHaveBeenCalledWith(
      "[talk] Parent context is too large to fork (150000/100000 tokens); starting with isolated context instead.",
    );
    expect(runtime.session.patchSessionEntry).toHaveBeenCalled();
    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expectNonEmptyString(call.sessionId);
    expect(call.sessionFile).toBeUndefined();
    expect(call.sessionTarget).toMatchObject({
      agentId: "main",
      sessionId: call.sessionId,
      sessionKey: "agent:main:subagent:google-meet:meet-1",
      storePath: testTempPath("sessions.json"),
    });
    expect(call.spawnedBy).toBe("agent:main:main");
  });

  it("inherits requester message routing for forked consult sessions", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["agent:main:discord:channel:123"] = {
      sessionId: "parent-session",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "channel:123", accountId: "default" },
      }),
      updatedAt: 1,
    };

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      spawnedBy: "agent:main:discord:channel:123",
      contextMode: "fork",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send a status message." },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.spawnedBy).toBe("agent:main:discord:channel:123");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.currentChannelId).toBe("channel:123");
    const voiceEntry = sessionStore["voice:google-meet:meet-1"];
    if (!voiceEntry) {
      throw new Error("Expected voice consult session entry");
    }
    expect(voiceEntry).toStrictEqual({
      sessionId: voiceEntry.sessionId,
      spawnedBy: "agent:main:discord:channel:123",
      createdVia: "talk",
      createdActor: { type: "agent", id: "agent:main:discord:channel:123" },
      createdAt: voiceEntry.createdAt,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "channel:123", accountId: "default" },
      }),
      updatedAt: voiceEntry.updatedAt,
    });
    expectNonEmptyString(voiceEntry.sessionId);
    expectPositiveTimestamp(voiceEntry.updatedAt);
  });

  it("reuses the call session delivery context when requester metadata is absent", async () => {
    const { runtime, runEmbeddedAgent, sessionStore } = createAgentRuntime();
    sessionStore["voice:google-meet:meet-1"] = {
      sessionId: "call-session",
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "discord",
          to: "channel:123",
          accountId: "default",
          threadId: "thread-456",
        },
      }),
      updatedAt: 1,
    };

    await consultRealtimeVoiceAgent({
      cfg: {} as never,
      agentRuntime: runtime as never,
      logger: { warn: vi.fn() },
      agentId: "main",
      sessionKey: "voice:google-meet:meet-1",
      messageProvider: "voice",
      lane: "voice",
      runIdPrefix: "voice-realtime-consult:call-1",
      args: { question: "Send this to the original chat." },
      transcript: [],
      surface: "a live phone call",
      userLabel: "Caller",
    });

    const call = requireEmbeddedAgentCall(runEmbeddedAgent);
    expect(call.sessionId).toBe("call-session");
    expect(call.sessionKey).toBe("voice:google-meet:meet-1");
    expect(call.messageProvider).toBe("discord");
    expect(call.agentAccountId).toBe("default");
    expect(call.messageTo).toBe("channel:123");
    expect(call.messageThreadId).toBe("thread-456");
    expect(call.currentChannelId).toBe("channel:123");
    expect(call.currentThreadTs).toBe("thread-456");
  });
});
