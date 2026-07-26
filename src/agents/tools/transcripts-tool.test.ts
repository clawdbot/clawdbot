// Transcripts tool tests cover manual imports, live provider lifecycle, summary
// artifacts, and date-qualified session selectors.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptStopRequest } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsAutoStartService, createTranscriptsTool } from "./transcripts-tool.js";

const { getTranscriptSourceProviderMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
}));

vi.mock("../../transcripts/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../transcripts/provider-registry.js")>();
  return {
    ...actual,
    getTranscriptSourceProvider: getTranscriptSourceProviderMock,
  };
});

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcripts-"));
}

function currentDateDir(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createHarness(
  stateDir: string,
  pluginConfig: Record<string, unknown> = {},
  agentId?: string,
) {
  const config = { transcripts: { enabled: true, ...pluginConfig } };
  const logger = { warn: vi.fn() };
  return {
    logger,
    service: createTranscriptsAutoStartService({ config, stateDir, logger }),
    tool: createTranscriptsTool({
      config,
      stateDir,
      logger,
      ...(agentId ? { agentId } : {}),
    }),
  };
}

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

describe("transcripts tool", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
  });

  it("creates the core transcripts tool", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);

    expect(tool.name).toBe("transcripts");
  });

  it("adds the trusted tool agent to live source ownership metadata", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => {
      expect(request.session).toMatchObject({
        source: {
          agentId: "research",
          meetingUrl: "https://zoom.us/j/1234567890?context=opaque-value#fragment",
          providerId: "zoom",
        },
        metadata: { agentId: "research" },
      });
      return { ok: false as const, error: "ownership checked" };
    });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
    });
    const { tool } = await createHarness(stateDir, {}, "research");

    await expect(
      tool.execute(
        "call-1",
        {
          action: "start",
          meetingUrl: "https://zoom.us/j/1234567890?context=opaque-value#fragment",
          providerId: "zoom",
          sessionId: "owned-meeting",
        },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("ownership checked");

    expect(start).toHaveBeenCalledOnce();
    await expect(storeFor(stateDir).readSession("owned-meeting")).resolves.toMatchObject({
      source: { meetingUrl: "https://zoom.us/j/1234567890" },
    });
  });

  it("keeps ownerless shipped sessions visible only to the main agent", async () => {
    const stateDir = await makeStateDir();
    const store = storeFor(stateDir);
    const legacySession = {
      sessionId: "legacy-ownerless",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-01T12:00:00.000Z",
      stoppedAt: "2026-07-01T12:05:00.000Z",
    };
    await store.writeSession(legacySession);
    await store.appendUtteranceForSession(legacySession, { text: "legacy notes" });
    const { tool: mainTool } = await createHarness(stateDir, {}, "main");
    const { tool: researchTool } = await createHarness(stateDir, {}, "research");

    await expect(
      mainTool.execute(
        "call-main",
        { action: "summarize", sessionId: legacySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: legacySession.sessionId } });
    await expect(
      researchTool.execute(
        "call-research",
        { action: "summarize", sessionId: legacySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(`transcripts session not found: ${legacySession.sessionId}`);
  });

  it("requires explicit enablement before execution", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir, { enabled: false });

    await expect(tool.execute("call-1", { action: "status" }, undefined, vi.fn())).rejects.toThrow(
      "transcripts are disabled",
    );
  });

  it("cancels a pending live capture when the agent run is aborted", async () => {
    const stateDir = await makeStateDir();
    const controller = new AbortController();
    const stop = vi.fn(async () => ({ ok: true, sessionId: "cancelled-meeting" }));
    const start = vi.fn(async (request) => {
      expect(request.abortSignal).not.toBe(controller.signal);
      expect(request.abortSignal?.aborted).toBe(false);
      controller.abort();
      expect(request.abortSignal?.aborted).toBe(true);
      return { ok: true, session: request.session };
    });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await expect(
      tool.execute(
        "call-1",
        {
          action: "start",
          providerId: "proof-live",
          sessionId: "cancelled-meeting",
        },
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts start aborted");

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cancelled-meeting",
        reason: "service-stop",
      }),
    );
  });

  it("keeps capturing after a successfully started agent run is later aborted", async () => {
    const stateDir = await makeStateDir();
    const controller = new AbortController();
    let emitAfterStart: (() => Promise<void>) | undefined;
    let startupSignal: AbortSignal | undefined;
    const start = vi.fn(async (request) => {
      startupSignal = request.abortSignal;
      emitAfterStart = async () => {
        await request.onUtterance({
          text: "captured after the start action completed\nsecond\tcolumn",
          final: true,
        });
      };
      return { ok: true, session: request.session };
    });
    const stop = vi.fn(async () => ({ ok: true, sessionId: "ongoing-meeting" }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "call-1",
      {
        action: "start",
        providerId: "proof-live",
        sessionId: "ongoing-meeting",
      },
      controller.signal,
      vi.fn(),
    );
    expect(startupSignal).not.toBe(controller.signal);
    controller.abort();
    expect(startupSignal?.aborted).toBe(false);
    await emitAfterStart?.();

    const ongoingStore = storeFor(stateDir);
    const ongoingSession = await ongoingStore.readSession("ongoing-meeting");
    expect(ongoingSession).toBeDefined();
    await expect(ongoingStore.readUtterancesForSession(ongoingSession!)).resolves.toEqual([
      expect.objectContaining({
        text: "captured after the start action completed\nsecond\tcolumn",
      }),
    ]);
    await tool.execute(
      "call-2",
      { action: "stop", sessionId: "ongoing-meeting" },
      undefined,
      vi.fn(),
    );
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "ongoing-meeting", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("captured after the start action completed\\nsecond\\tcolumn");
  });

  it("drops late utterances and keeps repeated abort cleanup failures retryable", async () => {
    const stateDir = await makeStateDir();
    const controller = new AbortController();
    let cleanupFailuresRemaining = 2;
    const stop = vi.fn(async () =>
      cleanupFailuresRemaining-- > 0
        ? { ok: false, error: "voice cleanup failed" }
        : { ok: true, sessionId: "cancelled-meeting-retry" },
    );
    const start = vi.fn(async (request) => {
      controller.abort();
      await request.onUtterance({
        text: "captured after agent cancellation",
        final: true,
      });
      return { ok: true, session: request.session };
    });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await expect(
      tool.execute(
        "call-1",
        {
          action: "start",
          providerId: "proof-live",
          sessionId: "cancelled-meeting-retry",
        },
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts start aborted; provider cleanup failed: voice cleanup failed");

    const cancelledStore = storeFor(stateDir);
    const cancelledSession = await cancelledStore.readSession("cancelled-meeting-retry");
    expect(cancelledSession).toBeDefined();
    await expect(cancelledStore.readUtterancesForSession(cancelledSession!)).resolves.toEqual([]);
    expect(stop).toHaveBeenCalledOnce();

    await expect(
      tool.execute(
        "call-retry-start",
        {
          action: "start",
          providerId: "proof-live",
          sessionId: "cancelled-meeting-retry",
        },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session already active: cancelled-meeting-retry");
    expect(start).toHaveBeenCalledOnce();

    await expect(
      tool.execute(
        "call-2",
        { action: "stop", sessionId: "cancelled-meeting-retry" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts provider cleanup failed: voice cleanup failed");
    expect(stop).toHaveBeenCalledTimes(2);

    await tool.execute(
      "call-3",
      { action: "stop", sessionId: "cancelled-meeting-retry" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("reserves a session id while provider startup is pending", async () => {
    const stateDir = await makeStateDir();
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const start = vi.fn(async (request) => {
      await startGate;
      return { ok: true as const, session: request.session };
    });
    const stop = vi.fn(async () => ({ ok: true as const, sessionId: "shared-session" }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    const firstStart = tool.execute(
      "call-1",
      { action: "start", providerId: "proof-live", sessionId: "shared-session" },
      undefined,
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });

    await expect(
      tool.execute(
        "call-2",
        { action: "start", providerId: "proof-live", sessionId: "shared-session" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session already active: shared-session");
    releaseStart?.();
    await firstStart;
    await tool.execute(
      "call-3",
      { action: "stop", sessionId: "shared-session" },
      undefined,
      vi.fn(),
    );

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps thrown abort cleanup failures retryable", async () => {
    const stateDir = await makeStateDir();
    const controller = new AbortController();
    let stopAttempts = 0;
    const stop = vi.fn(async (_request: TranscriptStopRequest) => {
      stopAttempts += 1;
      if (stopAttempts === 1) {
        throw new Error("voice cleanup threw");
      }
      return { ok: true as const, sessionId: "cancelled-meeting-thrown" };
    });
    const start = vi.fn(async (request) => {
      await request.onUtterance({ text: "captured before abort", final: true });
      controller.abort();
      return { ok: true as const, session: request.session };
    });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await expect(
      tool.execute(
        "call-1",
        {
          action: "start",
          providerId: "proof-live",
          sessionId: "cancelled-meeting-thrown",
        },
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts start aborted; provider cleanup failed: voice cleanup threw");
    await tool.execute(
      "call-2",
      { action: "stop", sessionId: "cancelled-meeting-thrown" },
      undefined,
      vi.fn(),
    );

    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls.map(([request]) => request.reason)).toEqual([
      "service-stop",
      "tool-stop",
    ]);
  });

  it("keeps missing abort cleanup hooks visible until the provider can stop", async () => {
    const stateDir = await makeStateDir();
    const controller = new AbortController();
    const start = vi.fn(async (request) => {
      controller.abort();
      return { ok: true as const, session: request.session };
    });
    const provider = {
      id: "proof-live",
      name: "Proof Live",
      sourceKinds: ["live-caption"],
      start,
    };
    getTranscriptSourceProviderMock.mockReturnValue(provider);
    const { tool } = await createHarness(stateDir);

    await expect(
      tool.execute(
        "call-1",
        {
          action: "start",
          providerId: "proof-live",
          sessionId: "cancelled-meeting-no-stop",
        },
        controller.signal,
        vi.fn(),
      ),
    ).rejects.toThrow(
      "transcripts start aborted; provider cleanup failed: transcripts provider proof-live cannot stop live capture",
    );

    await expect(
      tool.execute(
        "call-2",
        { action: "stop", sessionId: "cancelled-meeting-no-stop" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(
      "transcripts provider cleanup failed: transcripts provider proof-live cannot stop live capture",
    );
    const stop = vi.fn(async () => ({
      ok: true as const,
      sessionId: "cancelled-meeting-no-stop",
    }));
    getTranscriptSourceProviderMock.mockReturnValue({ ...provider, stop });
    await tool.execute(
      "call-3",
      { action: "stop", sessionId: "cancelled-meeting-no-stop" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("imports a speaker transcript and writes summary artifacts", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);

    const result = await tool.execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "design-review",
        title: "Design review",
        transcript:
          "Alex: We decided to ship Discord first.\nSam: Action item: add Slack import later.",
      },
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      details: {
        sessionId: "design-review",
        utteranceCount: 2,
      },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "design-review", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("Sam: Action item: add Slack import later.");
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "design-review", "summary.json"),
        "utf8",
      ),
    ).resolves.toContain('"Alex: We decided to ship Discord first."');
    const stored = await storeFor(stateDir).readSession("design-review");
    expect(stored).toBeDefined();
    await expect(storeFor(stateDir).readUtterancesForSession(stored!)).resolves.toEqual([
      expect.objectContaining({ text: "We decided to ship Discord first." }),
      expect.objectContaining({ text: "Action item: add Slack import later." }),
    ]);
  });

  it("bounds summary input while retaining the full transcript", async () => {
    // Exercise the fixed 2,000-utterance summary window while proving the
    // durable transcript still retains the complete import.
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);
    const transcript = Array.from(
      { length: 2_001 },
      (_, index) => `Alex: transcript line ${index}`,
    ).join("\n");

    await tool.execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "long-meeting",
        title: "Long meeting",
        transcript,
      },
      undefined,
      vi.fn(),
    );

    const summary = await fs.readFile(
      path.join(stateDir, "transcripts", currentDateDir(), "long-meeting", "summary.md"),
      "utf8",
    );
    expect(summary).not.toContain("transcript line 0\n");
    expect(summary).toContain("transcript line 2000");
    const stored = await storeFor(stateDir).readSession("long-meeting");
    expect(stored).toBeDefined();
    const storedTranscript = await storeFor(stateDir).readUtterancesForSession(stored!);
    expect(storedTranscript[0]?.text).toContain("transcript line 0");
    expect(storedTranscript.at(-1)?.text).toContain("transcript line 2000");
  });

  it("requires date-qualified selectors for repeated stored session ids", async () => {
    const stateDir = await makeStateDir();
    const store = storeFor(stateDir);
    await store.writeSession({
      sessionId: "standup",
      title: "Tuesday standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-21T10:00:00.000Z",
    });
    await store.writeSession({
      sessionId: "standup",
      title: "Wednesday standup",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    await expect(store.readSession("standup")).rejects.toThrow(
      "multiple transcripts sessions match standup",
    );
    await expect(store.readSession("2026-05-21/standup")).resolves.toMatchObject({
      title: "Tuesday standup",
    });
  });

  it("stops date-qualified active sessions with the canonical provider session id", async () => {
    // Date-qualified selectors disambiguate storage paths; providers still own
    // the original session id.
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => {
      await request.onUtterance({
        text: "Sam: Decision: use date-qualified selectors for repeated names.",
      });
      return { ok: true, session: request.session };
    });
    const stop = vi.fn(async () => ({ ok: true }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "call-1",
      {
        action: "start",
        providerId: "discord-voice",
        sessionId: "standup",
        title: "Standup",
      },
      undefined,
      vi.fn(),
    );
    const result = await tool.execute(
      "call-2",
      {
        action: "stop",
        sessionId: `${currentDateDir()}/standup`,
      },
      undefined,
      vi.fn(),
    );

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "standup",
      }),
    );
    expect(result).toMatchObject({
      details: {
        sessionId: "standup",
      },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "standup", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("date-qualified selectors");
  });

  it("finalizes an active session when the live provider stop fails", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => {
      await request.onUtterance({
        text: "Alex: Action item: publish the notes even after voice disconnects.",
      });
      return { ok: true, session: request.session };
    });
    const stop = vi.fn(async () => ({ ok: false, error: "Discord voice manager is unavailable" }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "call-1",
      {
        action: "start",
        providerId: "discord-voice",
        sessionId: "standup",
      },
      undefined,
      vi.fn(),
    );
    const result = await tool.execute(
      "call-2",
      {
        action: "stop",
        sessionId: "standup",
      },
      undefined,
      vi.fn(),
    );

    expect(result).toMatchObject({
      details: {
        providerStopError: "Discord voice manager is unavailable",
        sessionId: "standup",
      },
    });
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "standup", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("publish the notes");
    await expect(storeFor(stateDir).readSession("standup")).resolves.toMatchObject({
      metadata: { providerStopError: "Discord voice manager is unavailable" },
    });
  });

  it("does not stop a current active session when summarizing an older dated duplicate", async () => {
    const stateDir = await makeStateDir();
    const store = storeFor(stateDir);
    const olderSession = {
      sessionId: "standup",
      title: "Older standup",
      source: { providerId: "discord-voice" },
      startedAt: "2026-05-21T10:00:00.000Z",
      stoppedAt: "2026-05-21T10:30:00.000Z",
    };
    await store.writeSession(olderSession);
    await store.appendUtteranceForSession(olderSession, {
      text: "Sam: Decision: preserve historical dated notes.",
    });
    const start = vi.fn(async (request) => ({ ok: true, session: request.session }));
    const stop = vi.fn(async () => ({ ok: true }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "call-1",
      {
        action: "start",
        providerId: "discord-voice",
        sessionId: "standup",
        title: "Current standup",
      },
      undefined,
      vi.fn(),
    );
    await tool.execute(
      "call-2",
      {
        action: "stop",
        sessionId: "2026-05-21/standup",
      },
      undefined,
      vi.fn(),
    );

    expect(stop).not.toHaveBeenCalled();
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", "2026-05-21", "standup", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("preserve historical dated notes");

    await tool.execute(
      "call-3",
      {
        action: "stop",
        sessionId: "standup",
      },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "standup",
      }),
    );
  });

  it("auto-starts configured live meeting sources", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => ({ ok: true, session: request.session }));
    const stop = vi.fn(async () => ({ ok: true as const, sessionId: "standup" }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { service } = await createHarness(stateDir, {
      autoStart: [
        {
          providerId: "discord-voice",
          sessionId: "standup",
          title: "Standup",
          guildId: "guild-1",
          channelId: "channel-1",
        },
      ],
    });

    service.start();
    for (let i = 0; i < 20 && start.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }

    expect(getTranscriptSourceProviderMock).toHaveBeenCalledWith(
      "discord-voice",
      expect.objectContaining({ transcripts: expect.any(Object) }),
    );
    expect(start).toHaveBeenCalledOnce();
    const request = start.mock.calls[0]?.[0];
    if (!request) {
      throw new Error("Expected transcripts source start request");
    }
    expect(request.session).toMatchObject({
      sessionId: "standup",
      title: "Standup",
      source: {
        providerId: "discord-voice",
        guildId: "guild-1",
        channelId: "channel-1",
      },
    });
    expect(request.startupWaitMs).toBe(30_000);
    await expect(storeFor(stateDir).readSession("standup")).resolves.toMatchObject({
      title: "Standup",
    });
    await service.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("aborts pending auto-starts when the service stops", async () => {
    const stateDir = await makeStateDir();
    const stop = vi.fn(async () => ({ ok: true, sessionId: "standup" }));
    const start = vi.fn(
      async (request) =>
        await new Promise((resolve) => {
          request.abortSignal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "aborted" }),
            { once: true },
          );
        }),
    );
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { service, logger } = await createHarness(stateDir, {
      autoStart: [
        {
          providerId: "discord-voice",
          sessionId: "standup",
          guildId: "guild-1",
          channelId: "channel-1",
        },
      ],
    });
    service.start();
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    const request = start.mock.calls[0]?.[0];
    expect(request.abortSignal?.aborted).toBe(false);

    await service.stop();

    expect(request.abortSignal?.aborted).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
