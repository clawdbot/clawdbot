import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptsStore } from "../transcripts/store.js";
import { MeetingTranscriptDeliveryError } from "./session-transcript-store.js";
import type { MeetingSessionRecord } from "./session-types.js";
import { createMeetingDurableTranscriptBridge } from "./transcripts-bridge.runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

function session(): MeetingSessionRecord<"chrome", "agent"> {
  return {
    id: "meeting-1",
    url: "https://meeting.example/room",
    transport: "chrome",
    mode: "agent",
    agentId: "research",
    state: "active",
    createdAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:00.000Z",
    participantIdentity: "OpenClaw browser guest",
    realtime: { enabled: true, toolPolicy: "safe-read-only" },
    notes: [],
  };
}

describe("MeetingDurableTranscriptBridge", () => {
  it("replays stored lines to an attached provider and streams new lines in order", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    const onUtterance = vi.fn();
    const transcriptSession = {
      sessionId: "external-1",
      source: { providerId: "google-meet", agentId: "research", meetingUrl: current.url },
      startedAt: current.createdAt,
    };
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: {
        providerId: "google-meet",
        providerName: "Google Meet",
        stateDir,
      },
    });

    await bridge.start(current, async () => {});
    await bridge.ingest(current, [{ speaker: "Avery", text: "First line" }]);
    await expect(
      bridge.attach(current, {
        session: transcriptSession,
        onUtterance,
      }),
    ).resolves.toMatchObject({ ok: true });
    await bridge.ingest(current, [{ speaker: "Blake", text: "Second line" }]);
    await expect(
      bridge.detach({
        sessionId: "external-1",
        source: { providerId: "google-meet", agentId: "another-agent" },
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      bridge.detach({
        sessionId: "external-1",
        source: { providerId: "google-meet", agentId: "research" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const replayed = vi.fn();
    await expect(
      bridge.attach(current, { session: transcriptSession, onUtterance: replayed }),
    ).resolves.toMatchObject({ ok: true });
    await bridge.stop(current, async () => {});

    expect(onUtterance.mock.calls.map(([utterance]) => utterance)).toMatchObject([
      { sessionId: "external-1", speaker: { label: "Avery" }, text: "First line" },
      { sessionId: "external-1", speaker: { label: "Blake" }, text: "Second line" },
    ]);
    expect(replayed.mock.calls.map(([utterance]) => utterance.id)).toEqual(
      onUtterance.mock.calls.map(([utterance]) => utterance.id),
    );
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const stored = await store.readSession(current.id);
    expect(await store.readSummary(stored!)).toMatchObject({
      summary: { utteranceCount: 2 },
    });
  });

  it("honors the existing global transcripts opt-out", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: {
        config: { enabled: false },
        providerId: "zoom",
        providerName: "Zoom",
        stateDir,
      },
    });

    await bridge.start(session(), async () => {});

    expect(bridge.enabled).toBe(false);
    await expect(
      bridge.attach(session(), {
        session: {
          sessionId: "external-disabled",
          source: { providerId: "zoom", agentId: "research" },
          startedAt: "2026-07-23T12:00:00.000Z",
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rolls back an attachment when its start status callback fails", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: {
        providerId: "teams",
        providerName: "Microsoft Teams",
        stateDir,
      },
    });
    const transcriptSession = {
      sessionId: "external-status",
      source: { providerId: "teams", agentId: "research", meetingUrl: current.url },
      startedAt: current.createdAt,
    };
    await bridge.start(current, async () => {});

    await expect(
      bridge.attach(current, {
        session: transcriptSession,
        onStatus: async () => {
          throw new Error("status delivery failed");
        },
        onUtterance: vi.fn(),
      }),
    ).rejects.toThrow("status delivery failed");
    await expect(
      bridge.attach(current, {
        session: transcriptSession,
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: true });

    await bridge.stop(current, async () => {});
  });

  it("drains an in-flight periodic capture before the final capture", async () => {
    vi.useFakeTimers();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    let releasePeriodic!: () => void;
    const periodic = new Promise<void>((resolve) => {
      releasePeriodic = resolve;
    });
    let captureCount = 0;
    const capture = vi.fn(async () => {
      captureCount += 1;
      if (captureCount === 2) {
        await periodic;
      }
    });
    const finalCapture = vi.fn(async () => {});
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "zoom", providerName: "Zoom", stateDir },
    });
    await bridge.start(current, capture);
    await vi.advanceTimersByTimeAsync(5_000);

    const stopping = bridge.stop(current, finalCapture);
    expect(finalCapture).not.toHaveBeenCalled();
    releasePeriodic();
    await expect(stopping).resolves.toBe(true);

    expect(finalCapture).toHaveBeenCalledOnce();
  });

  it("retries final durable delivery before completing the capture", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    const finalCapture = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new MeetingTranscriptDeliveryError(new Error("write failed")))
      .mockRejectedValueOnce(new MeetingTranscriptDeliveryError(new Error("write failed")))
      .mockResolvedValueOnce();
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "teams", providerName: "Microsoft Teams", stateDir },
    });
    await bridge.start(current, async () => {});

    await expect(bridge.stop(current, finalCapture)).resolves.toBe(true);

    expect(finalCapture).toHaveBeenCalledTimes(3);
  });

  it("detaches a failing subscriber without blocking durable rows", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    const onUtterance = vi.fn(async () => {
      throw new Error("subscriber store unavailable");
    });
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "google-meet", providerName: "Google Meet", stateDir },
    });
    await bridge.start(current, async () => {});
    await bridge.attach(current, {
      session: {
        sessionId: "external-retry",
        source: { providerId: "google-meet", agentId: "research", meetingUrl: current.url },
        startedAt: current.createdAt,
      },
      onUtterance,
    });

    await expect(bridge.ingest(current, [{ text: "first" }])).resolves.toBeUndefined();
    await expect(bridge.ingest(current, [{ text: "second" }])).resolves.toBeUndefined();

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const stored = await store.readSession(current.id);
    expect(await store.readUtterancesForSession(stored!)).toHaveLength(2);
    expect(onUtterance).toHaveBeenCalledOnce();
    await bridge.stop(current, async () => {});
  });

  it("rejects attachments once finalization begins", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    let releaseFinal!: () => void;
    const finalizing = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "zoom", providerName: "Zoom", stateDir },
    });
    await bridge.start(current, async () => {});

    const stopping = bridge.stop(current, async () => await finalizing);
    await expect(
      bridge.attach(current, {
        session: {
          sessionId: "external-late",
          source: { providerId: "zoom", agentId: "research", meetingUrl: current.url },
          startedAt: current.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: false });
    releaseFinal();
    await expect(stopping).resolves.toBe(true);
  });

  it("drains subscriber delivery before detaching", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const onStatus = vi.fn(async () => {});
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "teams", providerName: "Microsoft Teams", stateDir },
    });
    await bridge.start(current, async () => {});
    await bridge.attach(current, {
      session: {
        sessionId: "external-drain",
        source: { providerId: "teams", agentId: "research", meetingUrl: current.url },
        startedAt: current.createdAt,
      },
      onStatus,
      onUtterance: async () => await delivery,
    });

    const ingesting = bridge.ingest(current, [{ text: "pending delivery" }]);
    const detaching = bridge.detach({
      sessionId: "external-drain",
      source: { providerId: "teams", agentId: "research" },
    });
    await Promise.resolve();
    expect(onStatus).toHaveBeenCalledTimes(1);
    releaseDelivery();
    await ingesting;
    await expect(detaching).resolves.toMatchObject({ ok: true });

    expect(onStatus).toHaveBeenCalledTimes(2);
    await bridge.stop(current, async () => {});
  });

  it("does not let terminal subscriber notification block finalization", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    let statusCalls = 0;
    const onStatus = vi.fn(() => {
      statusCalls += 1;
      if (statusCalls === 2) {
        throw new Error("terminal status unavailable");
      }
    });
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "zoom", providerName: "Zoom", stateDir },
    });
    await bridge.start(current, async () => {});
    await bridge.attach(current, {
      session: {
        sessionId: "external-terminal",
        source: { providerId: "zoom", agentId: "research", meetingUrl: current.url },
        startedAt: current.createdAt,
      },
      onStatus,
      onUtterance: vi.fn(),
    });

    await expect(bridge.stop(current, async () => {})).resolves.toBe(true);

    expect(onStatus).toHaveBeenCalledTimes(2);
  });

  it("queues detach behind a pending attachment replay", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    let releaseReplay!: () => void;
    const replay = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const onUtterance = vi.fn(async () => await replay);
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "google-meet", providerName: "Google Meet", stateDir },
    });
    await bridge.start(current, async () => {});
    await bridge.ingest(current, [{ text: "existing row" }]);
    const transcriptSession = {
      sessionId: "external-pending",
      source: { providerId: "google-meet", agentId: "research", meetingUrl: current.url },
      startedAt: current.createdAt,
    };

    const attaching = bridge.attach(current, { session: transcriptSession, onUtterance });
    const detaching = bridge.detach({
      sessionId: transcriptSession.sessionId,
      source: transcriptSession.source,
    });
    releaseReplay();
    await expect(attaching).resolves.toMatchObject({ ok: true });
    await expect(detaching).resolves.toMatchObject({ ok: true });
    await bridge.ingest(current, [{ text: "after detach" }]);

    expect(onUtterance).toHaveBeenCalledOnce();
    await bridge.stop(current, async () => {});
  });

  it("records a non-blocking final browser snapshot failure", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-bridge-"));
    tempDirs.push(stateDir);
    const current = session();
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "zoom", providerName: "Zoom", stateDir },
    });
    await bridge.start(current, async () => {});

    await expect(
      bridge.stop(current, async () => {
        throw new Error("");
      }),
    ).resolves.toBe(true);

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    await expect(store.readSession(current.id)).resolves.toMatchObject({
      metadata: {
        finalCaptureError: "",
        finalCaptureFailedAt: expect.any(String),
      },
      stoppedAt: expect.any(String),
    });
  });
});
