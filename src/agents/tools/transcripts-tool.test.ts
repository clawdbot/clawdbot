// Transcripts tool tests cover manual imports, live provider lifecycle, summary
// artifacts, and date-qualified session selectors.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "../../transcripts/auto-start.js";
import { startTranscripts } from "../../transcripts/capture.js";
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
  TranscriptStopRequest,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getTranscriptSourceProviderMock, listTranscriptSourceProvidersMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
  listTranscriptSourceProvidersMock: vi.fn(() => []),
}));

vi.mock("../../transcripts/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../transcripts/provider-registry.js")>();
  return {
    ...actual,
    getTranscriptSourceProvider: getTranscriptSourceProviderMock,
    listTranscriptSourceProviders: listTranscriptSourceProvidersMock,
  };
});
const tempDirs = createTempDirTracker();

function currentDateDir(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createHarness(
  stateDir: string,
  pluginConfig: Record<string, unknown> = {},
  agentId?: string,
  origin?: { channel: string; accountId: string },
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
      ...(origin ? { agentChannel: origin.channel, agentAccountId: origin.accountId } : {}),
      caller: origin
        ? {
            kind: "channel",
            channel: origin.channel,
            accountId: origin.accountId,
            senderId: "test-sender",
            roleIds: [],
          }
        : { kind: "operator", source: "local" },
    }),
  };
}

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function discordAccountOwnership(
  resolveAccountId: NonNullable<TranscriptSourceProvider["accessControl"]>["resolveAccountId"] = ({
    source,
  }) => ({ ok: true, value: source.accountId }),
): NonNullable<TranscriptSourceProvider["accessControl"]> {
  return {
    channelId: "discord",
    resolveAccountId,
    authorize: async ({ caller, source }) =>
      caller.kind === "operator" ||
      (caller.channel === "discord" && caller.accountId === source.accountId)
        ? { ok: true as const, value: undefined }
        : { ok: false as const, error: "account denied" },
  };
}

describe("transcripts tool", () => {
  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
    listTranscriptSourceProvidersMock.mockClear();
  });

  it("creates the core transcripts tool", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const { tool } = await createHarness(stateDir);

    expect(tool.name).toBe("transcripts");
  });

  it("adds the trusted tool agent to live source ownership metadata", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
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

  it("lets a channel-less tool without an agent id manage its account-bound capture", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    const stop = vi.fn(async (request) => ({ ok: true as const, sessionId: request.sessionId }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      accessControl: discordAccountOwnership(),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);

    await tool.execute(
      "start-local",
      {
        action: "start",
        providerId: "discord-voice",
        accountId: "account-a",
        sessionId: "local-account-bound",
      },
      undefined,
      vi.fn(),
    );
    await expect(
      tool.execute("status-local", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "local-account-bound" })] },
    });
    await tool.execute(
      "stop-local",
      { action: "stop", sessionId: "local-account-bound" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ accountId: "account-a" }) }),
    );
  });

  it("requires explicit enablement before execution", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const { tool } = await createHarness(stateDir, { enabled: false });

    await expect(tool.execute("call-1", { action: "status" }, undefined, vi.fn())).rejects.toThrow(
      "transcripts are disabled",
    );
  });

  it("cancels a pending live capture when the agent run is aborted", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
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
    const stateDir = tempDirs.make("openclaw-transcripts-");
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
    const stateDir = tempDirs.make("openclaw-transcripts-");
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
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const started = createDeferred();
    const startGate = createDeferred();
    const start = vi.fn(async (request) => {
      started.resolve();
      await startGate.promise;
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
    await started.promise;
    try {
      await expect(
        tool.execute(
          "call-2",
          { action: "start", providerId: "proof-live", sessionId: "shared-session" },
          undefined,
          vi.fn(),
        ),
      ).rejects.toThrow("transcripts session already active: shared-session");
      await expect(
        tool.execute("stop-pending", { action: "stop", sessionId: "shared-session" }),
      ).resolves.toMatchObject({ details: { sessionId: "shared-session", skipped: true } });
      expect(stop).not.toHaveBeenCalled();
    } finally {
      startGate.resolve();
      await firstStart;
      await tool.execute(
        "call-3",
        { action: "stop", sessionId: "shared-session" },
        undefined,
        vi.fn(),
      );
    }

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps thrown abort cleanup failures retryable", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
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
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const controller = new AbortController();
    const start = vi.fn(async (request) => {
      controller.abort();
      return { ok: true as const, session: request.session };
    });
    const provider: TranscriptSourceProvider = {
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
    provider.stop = stop;
    await tool.execute(
      "call-3",
      { action: "stop", sessionId: "cancelled-meeting-no-stop" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops date-qualified active sessions with the canonical provider session id", async () => {
    // Date-qualified selectors disambiguate storage paths; providers still own
    // the original session id.
    const stateDir = tempDirs.make("openclaw-transcripts-");
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

  it("retains failed provider cleanup until retry succeeds before writing notes", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const start = vi.fn(async (request) => {
      await request.onUtterance({ text: "Alex: Publish notes after voice cleanup completes." });
      return { ok: true, session: request.session };
    });
    const stop = vi
      .fn<NonNullable<TranscriptSourceProvider["stop"]>>()
      .mockResolvedValueOnce({ ok: false, error: "Discord voice manager is unavailable" })
      .mockResolvedValue({ ok: true, sessionId: "standup" });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(stateDir);
    await tool.execute("start", {
      action: "start",
      providerId: "discord-voice",
      sessionId: "standup",
    });
    await expect(tool.execute("stop", { action: "stop", sessionId: "standup" })).rejects.toThrow(
      "Discord voice manager is unavailable",
    );
    const store = storeFor(stateDir);
    const session = (await store.readSession("standup"))!;
    expect(session.stoppedAt).toBeUndefined();
    expect(await store.readSummary(session)).toEqual({});
    await expect(tool.execute("status", { action: "status" })).resolves.toMatchObject({
      details: { active: [{ sessionId: "standup", cleanupPending: true }] },
    });
    await tool.execute("retry-stop", { action: "stop", sessionId: "standup" });
    expect(stop).toHaveBeenCalledTimes(2);
    expect((await store.readSession("standup"))?.stoppedAt).toEqual(expect.any(String));
    expect(await store.readSummary(session)).toMatchObject({
      summary: { transcript: ["Alex: Publish notes after voice cleanup completes."] },
    });
  });

  it("does not stop a current active session when summarizing an older dated duplicate", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
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
    await expect(store.readSession("2026-05-21/standup")).resolves.toMatchObject({
      stoppedAt: olderSession.stoppedAt,
    });
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
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const start = vi.fn(async (request) => ({ ok: true, session: request.session }));
    const stop = vi.fn(async () => ({ ok: true as const, sessionId: "standup" }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      accessControl: discordAccountOwnership(),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { service, tool } = await createHarness(
      stateDir,
      {
        autoStart: [
          {
            providerId: "discord-voice",
            accountId: "account-a",
            sessionId: "standup",
            title: "Standup",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        ],
      },
      "main",
    );

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
        accountId: "account-a",
        providerId: "discord-voice",
        guildId: "guild-1",
        channelId: "channel-1",
      },
    });
    expect(request.startupWaitMs).toBe(30_000);
    await expect(storeFor(stateDir).readSession("standup")).resolves.toMatchObject({
      title: "Standup",
      source: { accountId: "account-a" },
      metadata: { agentId: "main" },
    });
    await expect(
      tool.execute("status-auto-start", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "standup" })] },
    });
    await tool.execute(
      "stop-auto-start",
      { action: "stop", sessionId: "standup" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledOnce();
    await service.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["account-a", undefined])(
    "lets the routed agent read auto-started notes with account %s",
    async (accountId) => {
      const stateDir = tempDirs.make("openclaw-transcripts-routed-");
      const config: OpenClawConfig = {
        agents: { entries: { main: {}, research: {} } },
        bindings: [
          {
            type: "route",
            agentId: "research",
            match: {
              channel: "discord",
              accountId: "account-a",
              peer: { kind: "channel", id: "room-a" },
            },
          },
        ],
        transcripts: {
          autoStart: [
            {
              providerId: "room-audio",
              accountId,
              guildId: "guild-a",
              channelId: "room-a",
            },
          ],
        },
      };
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        await request.onUtterance({
          text: "Decision: keep meeting notes with their routed agent.",
        });
        return { ok: true as const, session: request.session };
      });
      getTranscriptSourceProviderMock.mockReturnValue({
        id: "room-audio",
        name: "Room Audio",
        sourceKinds: ["live-audio"],
        accessControl: discordAccountOwnership(() => ({ ok: true, value: "account-a" })),
        start,
        stop: async (request: TranscriptStopRequest) => ({
          ok: true as const,
          sessionId: request.sessionId,
        }),
      } satisfies TranscriptSourceProvider);
      const logger = { warn: vi.fn() };
      const service = createTranscriptsAutoStartService({ config, stateDir, logger });
      const toolOptions = {
        config,
        stateDir,
        caller: { kind: "operator", source: "local" },
      } as const;
      const ownerTool = createTranscriptsTool({ ...toolOptions, agentId: "research" });
      const otherTool = createTranscriptsTool({ ...toolOptions, agentId: "main" });

      service.start();
      try {
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        const sessionId = start.mock.calls[0]![0].session.sessionId;
        await expect(storeFor(stateDir).readSession(sessionId)).resolves.toMatchObject({
          metadata: { agentId: "research" },
          source: { agentId: "research", accountId: "account-a" },
        });
        const statusResult = await ownerTool.execute("routed-status", { action: "status" });
        expect(statusResult).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining(sessionId) }],
          details: { active: [expect.objectContaining({ sessionId })] },
        });
        for (const identity of ["room-audio", "account-a", "guild-a", "room-a"]) {
          expect(statusResult.content).toEqual([
            { type: "text", text: expect.stringContaining(identity) },
          ]);
        }
        await expect(
          otherTool.execute("other-status", { action: "status" }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: expect.not.stringContaining(sessionId) }],
          details: { active: [] },
        });
        await expect(
          ownerTool.execute("routed-summary", { action: "summarize", sessionId }),
        ).resolves.toMatchObject({ details: { sessionId } });
      } finally {
        await service.stop();
      }
    },
  );

  it("does not retain an explicit account when provider resolution returns undefined", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      accessControl: discordAccountOwnership(() => ({
        ok: true as const,
        value: undefined,
      })),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
    });
    const store = storeFor(stateDir);

    await expect(
      startTranscripts({
        ctx: {
          config: { transcripts: { enabled: true } },
          stateDir,
          logger: { warn: vi.fn() },
        },
        store,
        rawParams: {
          providerId: "discord-voice",
          accountId: "caller-account",
          sessionId: "unresolved-account",
        },
        configuredLifecycle: true,
      }),
    ).rejects.toThrow(
      "transcripts provider discord-voice could not resolve an account for configured auto-start",
    );
    expect(start).not.toHaveBeenCalled();
    await expect(store.readSession("unresolved-account")).resolves.toBeUndefined();
  });

  it("keeps a session reserved while an overlapping stop is in flight", async () => {
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    let resolveFirstStop: ((result: { ok: true; sessionId: string }) => void) | undefined;
    const firstStop = new Promise<{ ok: true; sessionId: string }>((resolve) => {
      resolveFirstStop = resolve;
    });
    let stopCount = 0;
    const stop = vi.fn(async (request: TranscriptStopRequest) => {
      stopCount += 1;
      return stopCount === 1
        ? await firstStop
        : { ok: true as const, sessionId: request.sessionId };
    });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { tool } = await createHarness(tempDirs.make("openclaw-transcripts-"));

    await tool.execute(
      "start-original",
      { action: "start", providerId: "discord-voice", sessionId: "reused-id" },
      undefined,
      vi.fn(),
    );
    const firstStopCall = tool.execute(
      "stop-original",
      { action: "stop", sessionId: "reused-id" },
      undefined,
      vi.fn(),
    );
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    try {
      await expect(
        tool.execute(
          "stop-overlap",
          { action: "stop", sessionId: "reused-id" },
          undefined,
          vi.fn(),
        ),
      ).resolves.toMatchObject({ details: { sessionId: "reused-id", skipped: true } });
      expect(stop).toHaveBeenCalledOnce();
      await expect(
        tool.execute(
          "start-replacement-too-early",
          { action: "start", providerId: "discord-voice", sessionId: "reused-id" },
          undefined,
          vi.fn(),
        ),
      ).rejects.toThrow("transcripts session already active: reused-id");
    } finally {
      resolveFirstStop?.({ ok: true, sessionId: "reused-id" });
      await firstStopCall;
    }

    const { tool: replacementTool } = await createHarness(
      tempDirs.make("openclaw-transcripts-replacement-"),
    );
    await replacementTool.execute(
      "start-replacement",
      { action: "start", providerId: "discord-voice", sessionId: "reused-id" },
      undefined,
      vi.fn(),
    );
    await expect(
      replacementTool.execute("replacement-status", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "reused-id" })] },
    });
    await replacementTool.execute(
      "stop-replacement",
      { action: "stop", sessionId: "reused-id" },
      undefined,
      vi.fn(),
    );
  });

  it("aborts pending auto-starts when the service stops", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-");
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
