import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

async function createHarness(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const config = { transcripts: { enabled: true, ...pluginConfig } };
  const logger = { warn: vi.fn() };
  return {
    logger,
    service: createTranscriptsAutoStartService({ config, stateDir, logger }),
    tool: createTranscriptsTool({ config, stateDir, logger }),
  };
}

describe("transcripts tool", () => {
  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
  });

  it("creates the core transcripts tool", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir);

    expect(tool.name).toBe("transcripts");
  });

  it("requires explicit enablement before execution", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir, { enabled: false });

    await expect(tool.execute("call-1", { action: "status" }, undefined, vi.fn())).rejects.toThrow(
      "transcripts are disabled",
    );
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
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "design-review", "transcript.jsonl"),
        "utf8",
      ),
    ).resolves.toContain("Alex");
  });

  it("bounds summary input while retaining the full transcript", async () => {
    const stateDir = await makeStateDir();
    const { tool } = await createHarness(stateDir, { maxUtterances: 1 });

    await tool.execute(
      "call-1",
      {
        action: "import",
        providerId: "manual-transcript",
        sessionId: "long-meeting",
        title: "Long meeting",
        transcript:
          "Alex: Action item: write the first draft.\nSam: Decision: ship the final plan.",
      },
      undefined,
      vi.fn(),
    );

    const summary = await fs.readFile(
      path.join(stateDir, "transcripts", currentDateDir(), "long-meeting", "summary.md"),
      "utf8",
    );
    expect(summary).toContain("Decision: ship the final plan.");
    expect(summary).not.toContain("Action item: write the first draft.");
    expect(summary).toContain("## Transcript");
    expect(summary).toContain("Sam: Decision: ship the final plan.");
    const transcript = await fs.readFile(
      path.join(stateDir, "transcripts", currentDateDir(), "long-meeting", "transcript.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("Action item: write the first draft.");
    expect(transcript).toContain("Decision: ship the final plan.");
  });

  it("requires date-qualified selectors for repeated stored session ids", async () => {
    const stateDir = await makeStateDir();
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
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
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "standup", "metadata.json"),
        "utf8",
      ),
    ).resolves.toContain("providerStopError");
  });

  it("does not stop a current active session when summarizing an older dated duplicate", async () => {
    const stateDir = await makeStateDir();
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
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
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
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
      await new Promise((resolve) => setTimeout(resolve, 10));
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
    await expect(
      fs.readFile(
        path.join(stateDir, "transcripts", currentDateDir(), "standup", "metadata.json"),
        "utf8",
      ),
    ).resolves.toContain("Standup");
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
