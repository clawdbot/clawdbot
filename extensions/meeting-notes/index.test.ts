import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingNotesStore } from "./src/store.js";

const { getMeetingNotesSourceProviderMock } = vi.hoisted(() => ({
  getMeetingNotesSourceProviderMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-notes")>();
  return {
    ...actual,
    getMeetingNotesSourceProvider: getMeetingNotesSourceProviderMock,
  };
});

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
}

function currentDateDir(): string {
  return new Date().toISOString().slice(0, 10);
}

async function createHarness(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const providers: unknown[] = [];
  const tools: AnyAgentTool[] = [];
  const services: OpenClawPluginService[] = [];
  const cliRegistrars: Array<{
    registrar: unknown;
    opts: unknown;
  }> = [];
  const api = createTestPluginApi({
    pluginConfig,
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
    } as never,
    registerMeetingNotesSourceProvider: (provider) => providers.push(provider),
    registerTool: (tool) => tools.push(tool as AnyAgentTool),
    registerService: (service) => services.push(service),
    registerCli: (registrar, opts) => cliRegistrars.push({ registrar, opts }),
  });
  const { default: meetingNotesPlugin } = await import("./index.js");
  meetingNotesPlugin.register(api);
  return { cliRegistrars, providers, services, tool: tools[0] };
}

describe("meeting-notes plugin", () => {
  beforeEach(() => {
    getMeetingNotesSourceProviderMock.mockReset();
  });

  it("registers the manual transcript source and tool", async () => {
    const stateDir = await makeStateDir();
    const { cliRegistrars, providers, tool } = await createHarness(stateDir);

    expect(providers).toHaveLength(1);
    expect(tool?.name).toBe("meeting_notes");
    expect(cliRegistrars[0]?.opts).toMatchObject({
      descriptors: [{ name: "meeting-notes", hasSubcommands: true }],
    });
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
        path.join(stateDir, "meeting-notes", currentDateDir(), "design-review", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("Sam: Action item: add Slack import later.");
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "design-review", "summary.json"),
        "utf8",
      ),
    ).resolves.toContain('"Alex: We decided to ship Discord first."');
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "design-review", "transcript.jsonl"),
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
      path.join(stateDir, "meeting-notes", currentDateDir(), "long-meeting", "summary.md"),
      "utf8",
    );
    expect(summary).toContain("Decision: ship the final plan.");
    expect(summary).not.toContain("Action item: write the first draft.");
    expect(summary).toContain("## Transcript");
    expect(summary).toContain("Sam: Decision: ship the final plan.");
    const transcript = await fs.readFile(
      path.join(stateDir, "meeting-notes", currentDateDir(), "long-meeting", "transcript.jsonl"),
      "utf8",
    );
    expect(transcript).toContain("Action item: write the first draft.");
    expect(transcript).toContain("Decision: ship the final plan.");
  });

  it("requires date-qualified selectors for repeated stored session ids", async () => {
    const stateDir = await makeStateDir();
    const store = new MeetingNotesStore(path.join(stateDir, "meeting-notes"));
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
      "multiple meeting notes sessions match standup",
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
    getMeetingNotesSourceProviderMock.mockReturnValue({
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
        path.join(stateDir, "meeting-notes", currentDateDir(), "standup", "summary.md"),
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
    getMeetingNotesSourceProviderMock.mockReturnValue({
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
        path.join(stateDir, "meeting-notes", currentDateDir(), "standup", "summary.md"),
        "utf8",
      ),
    ).resolves.toContain("publish the notes");
    await expect(
      fs.readFile(
        path.join(stateDir, "meeting-notes", currentDateDir(), "standup", "metadata.json"),
        "utf8",
      ),
    ).resolves.toContain("providerStopError");
  });

  it("does not stop a current active session when summarizing an older dated duplicate", async () => {
    const stateDir = await makeStateDir();
    const store = new MeetingNotesStore(path.join(stateDir, "meeting-notes"));
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
    getMeetingNotesSourceProviderMock.mockReturnValue({
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
        path.join(stateDir, "meeting-notes", "2026-05-21", "standup", "summary.md"),
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
    getMeetingNotesSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
    });
    const { services } = await createHarness(stateDir, {
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
    expect(services).toHaveLength(1);

    await services[0]?.start({
      config: {},
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      stateDir,
    });
    for (let i = 0; i < 20 && start.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(getMeetingNotesSourceProviderMock).toHaveBeenCalledWith("discord-voice", {});
    expect(start).toHaveBeenCalledOnce();
    const request = start.mock.calls[0]?.[0];
    if (!request) {
      throw new Error("Expected meeting notes source start request");
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
        path.join(stateDir, "meeting-notes", currentDateDir(), "standup", "metadata.json"),
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
    getMeetingNotesSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const { services } = await createHarness(stateDir, {
      autoStart: [
        {
          providerId: "discord-voice",
          sessionId: "standup",
          guildId: "guild-1",
          channelId: "channel-1",
        },
      ],
    });
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const service = services[0];
    if (!service?.stop) {
      throw new Error("Expected meeting notes service with stop hook");
    }

    await service.start({ config: {}, logger, stateDir });
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    const request = start.mock.calls[0]?.[0];
    expect(request.abortSignal?.aborted).toBe(false);

    await service.stop({ config: {}, logger, stateDir });

    expect(request.abortSignal?.aborted).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
