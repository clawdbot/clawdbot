import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { activeSessions } from "./transcripts-tool-runtime.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getTranscriptSourceProviderMock, listTranscriptSourceProvidersMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
  listTranscriptSourceProvidersMock: vi.fn(() => []),
}));

vi.mock("../../transcripts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../transcripts/provider-registry.js")>()),
  getTranscriptSourceProvider: getTranscriptSourceProviderMock,
  listTranscriptSourceProviders: listTranscriptSourceProvidersMock,
}));

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcripts-account-"));
}

function createTool(
  stateDir: string,
  agentId: string,
  origin?: { channel: string; accountId?: string },
) {
  return createTranscriptsTool({
    config: { transcripts: { enabled: true } },
    stateDir,
    agentId,
    ...(origin ? { agentChannel: origin.channel } : {}),
    ...(origin?.accountId ? { agentAccountId: origin.accountId } : {}),
  });
}

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

describe("transcripts tool account ownership", () => {
  afterEach(() => {
    activeSessions.clear();
    closeOpenClawStateDatabaseForTest();
  });

  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
    listTranscriptSourceProvidersMock.mockClear();
  });

  it("binds same-channel capture and lifecycle access to the trusted turn account", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    const stop = vi.fn(async () => ({ ok: true as const, sessionId: "account-bound" }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accountBindingChannels: ["discord"],
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    });
    const ownerTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-a",
    });

    const result = await ownerTool.execute(
      "call-account-bound",
      {
        action: "start",
        providerId: "discord-voice",
        accountId: "account-b",
        guildId: "guild-b",
        channelId: "channel-b",
        sessionId: "account-bound",
      },
      undefined,
      vi.fn(),
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          source: expect.objectContaining({ accountId: "account-a" }),
        }),
      }),
    );
    await expect(storeFor(stateDir).readSession("account-bound")).resolves.toMatchObject({
      source: { accountId: "account-a" },
      metadata: {
        agentId: "main",
        ownerAccountId: "account-a",
        ownerChannel: "discord",
      },
    });
    expect(result.details).toMatchObject({ accountId: "account-a" });

    const otherAccountTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-b",
    });
    await expect(
      otherAccountTool.execute("call-status", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({ details: { active: [] } });
    await expect(
      otherAccountTool.execute(
        "call-stop",
        { action: "stop", sessionId: "account-bound" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: account-bound");
    expect(stop).not.toHaveBeenCalled();

    getTranscriptSourceProviderMock.mockReturnValue(undefined);
    await expect(
      createTool(stateDir, "main", { channel: "webchat", accountId: "operator" }).execute(
        "call-provider-missing-webchat",
        { action: "status" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "account-bound" })] },
    });
    await expect(
      ownerTool.execute("call-provider-missing-owner", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "account-bound" })] },
    });
    await expect(
      createTool(stateDir, "main").execute(
        "call-local-operator-status",
        { action: "status" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({
      details: { active: [expect.objectContaining({ sessionId: "account-bound" })] },
    });
  });

  it("preserves explicit accounts for providers outside the turn channel namespace", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "google-meet",
      aliases: ["googlemeet"],
      name: "Google Meet",
      sourceKinds: ["live-caption"],
      start,
    });

    await createTool(stateDir, "main", {
      channel: "discord",
      accountId: "discord-account",
    }).execute(
      "call-cross-provider",
      {
        action: "start",
        providerId: "google-meet",
        accountId: "meet-account",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        sessionId: "cross-provider",
      },
      undefined,
      vi.fn(),
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          source: expect.objectContaining({ accountId: "meet-account" }),
        }),
      }),
    );
  });

  it("requires trusted accounts only for starts from a provider's binding channel", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accountBindingChannels: ["discord"],
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
    });
    const startParams = {
      action: "start",
      providerId: "discord-voice",
      accountId: "account-a",
      guildId: "guild-a",
      channelId: "voice-a",
    };
    const expectedError =
      "transcripts provider discord-voice requires trusted account context from discord";

    await expect(
      createTool(stateDir, "main", { channel: "webchat", accountId: "operator" }).execute(
        "call-webchat",
        { ...startParams, sessionId: "webchat-start" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "webchat-start" } });
    await expect(
      createTool(stateDir, "main", { channel: "discord" }).execute(
        "call-missing-account",
        { ...startParams, sessionId: "missing-account" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(expectedError);
    await expect(
      createTool(stateDir, "research").execute(
        "call-unchanneled-non-main",
        { ...startParams, sessionId: "unchanneled-non-main" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "unchanneled-non-main" } });

    await expect(
      createTool(stateDir, "main").execute(
        "call-local",
        { ...startParams, sessionId: "local-start" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "local-start" } });
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("does not treat provider lookup aliases as account binding channels", async () => {
    const stateDir = await makeStateDir();
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "teams",
      aliases: ["msteams"],
      name: "Teams Meetings",
      sourceKinds: ["live-caption"],
      start,
    });

    const result = await createTool(stateDir, "main", {
      channel: "msteams",
      accountId: "chat-account",
    }).execute(
      "call-alias-collision",
      {
        action: "start",
        providerId: "teams",
        accountId: "meeting-account",
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
        sessionId: "alias-collision",
      },
      undefined,
      vi.fn(),
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          source: expect.objectContaining({ accountId: "meeting-account" }),
        }),
      }),
    );
    expect(result.details).toMatchObject({ accountId: "meeting-account" });
  });

  it("preserves shipped agent ownership while binding matching legacy channel accounts", async () => {
    const stateDir = await makeStateDir();
    const store = storeFor(stateDir);
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accountBindingChannels: ["discord"],
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
    });
    const sessions = [
      {
        sessionId: "stable-ownerless",
        source: { providerId: "discord-voice", accountId: "account-a" },
        startedAt: "2026-07-01T12:00:00.000Z",
        stoppedAt: "2026-07-01T12:05:00.000Z",
      },
      {
        sessionId: "beta-agent-only",
        source: { providerId: "discord-voice", accountId: "account-a" },
        startedAt: "2026-07-02T12:00:00.000Z",
        stoppedAt: "2026-07-02T12:05:00.000Z",
        metadata: { agentId: "main" },
      },
      {
        sessionId: "beta-named-agent",
        source: { providerId: "discord-voice", accountId: "account-a" },
        startedAt: "2026-07-03T12:00:00.000Z",
        stoppedAt: "2026-07-03T12:05:00.000Z",
        metadata: { agentId: "research" },
      },
    ];
    for (const session of sessions) {
      await store.writeSession(session);
      await store.appendUtteranceForSession(session, { text: "shipped notes" });
    }
    const discordTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-a",
    });
    const webchatTool = createTool(stateDir, "main", {
      channel: "webchat",
      accountId: "operator",
    });
    const localMainTool = createTool(stateDir, "main");

    for (const channelTool of [discordTool, webchatTool]) {
      await expect(
        channelTool.execute(
          "call-ownerless-channel",
          { action: "summarize", sessionId: "stable-ownerless" },
          undefined,
          vi.fn(),
        ),
      ).rejects.toThrow("transcripts session not found: stable-ownerless");
    }
    await expect(
      localMainTool.execute(
        "call-ownerless-local",
        { action: "summarize", sessionId: "stable-ownerless" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "stable-ownerless" } });

    for (const tool of [discordTool, webchatTool, localMainTool]) {
      await expect(
        tool.execute(
          "call-main-owned-legacy",
          { action: "summarize", sessionId: "beta-agent-only" },
          undefined,
          vi.fn(),
        ),
      ).resolves.toMatchObject({ details: { sessionId: "beta-agent-only" } });
    }
    await expect(
      createTool(stateDir, "main", { channel: "discord", accountId: "account-b" }).execute(
        "call-main-owned-wrong-account",
        { action: "summarize", sessionId: "beta-agent-only" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-agent-only");

    const researchTools = [
      createTool(stateDir, "research", { channel: "discord", accountId: "account-a" }),
      createTool(stateDir, "research", { channel: "webchat", accountId: "operator" }),
      createTool(stateDir, "research"),
    ];
    for (const tool of researchTools) {
      await expect(
        tool.execute(
          "call-named-agent-legacy",
          { action: "summarize", sessionId: "beta-named-agent" },
          undefined,
          vi.fn(),
        ),
      ).resolves.toMatchObject({ details: { sessionId: "beta-named-agent" } });
    }
    await expect(
      localMainTool.execute(
        "call-named-agent-boundary",
        { action: "summarize", sessionId: "beta-named-agent" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-named-agent");

    getTranscriptSourceProviderMock.mockReturnValue(undefined);
    await expect(
      webchatTool.execute(
        "call-provider-missing-legacy",
        { action: "summarize", sessionId: "stable-ownerless" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "stable-ownerless" } });
    await expect(
      localMainTool.execute(
        "call-provider-missing-local",
        { action: "summarize", sessionId: "stable-ownerless" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "stable-ownerless" } });
    await expect(
      webchatTool.execute(
        "call-provider-missing-owned",
        { action: "summarize", sessionId: "beta-agent-only" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-agent-only" } });
  });

  it("preserves main-agent access to ownerless non-binding sessions", async () => {
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

    await expect(
      createTool(stateDir, "main").execute(
        "call-main",
        { action: "summarize", sessionId: legacySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: legacySession.sessionId } });
    await expect(
      createTool(stateDir, "main", { channel: "webchat", accountId: "operator" }).execute(
        "call-main-webchat",
        { action: "summarize", sessionId: legacySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: legacySession.sessionId } });
    await expect(
      createTool(stateDir, "research").execute(
        "call-research",
        { action: "summarize", sessionId: legacySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(`transcripts session not found: ${legacySession.sessionId}`);
  });

  it("keeps named-agent ownership authoritative for non-binding sources", async () => {
    const stateDir = await makeStateDir();
    const store = storeFor(stateDir);
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "meeting-provider",
      name: "Meeting Provider",
      sourceKinds: ["live-caption"],
    });
    const sessions = [
      {
        sessionId: "research-import",
        source: { providerId: "manual-transcript" },
        startedAt: "2026-08-01T12:00:00.000Z",
        stoppedAt: "2026-08-01T12:05:00.000Z",
        metadata: { agentId: "research" },
      },
      {
        sessionId: "research-meeting",
        source: { providerId: "meeting-provider" },
        startedAt: "2026-08-01T13:00:00.000Z",
        stoppedAt: "2026-08-01T13:05:00.000Z",
        metadata: { agentId: "research" },
      },
    ];
    for (const session of sessions) {
      await store.writeSession(session);
      await store.appendUtteranceForSession(session, { text: "research notes" });
      await expect(
        createTool(stateDir, "research").execute(
          `call-research-${session.sessionId}`,
          { action: "summarize", sessionId: session.sessionId },
          undefined,
          vi.fn(),
        ),
      ).resolves.toMatchObject({ details: { sessionId: session.sessionId } });
      await expect(
        createTool(stateDir, "main").execute(
          `call-main-${session.sessionId}`,
          { action: "summarize", sessionId: session.sessionId },
          undefined,
          vi.fn(),
        ),
      ).rejects.toThrow(`transcripts session not found: ${session.sessionId}`);
    }
  });
});
