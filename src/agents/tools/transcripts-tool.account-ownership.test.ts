import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { activeSessions } from "./transcripts-tool-runtime.js";
import { createTranscriptsAutoStartService, createTranscriptsTool } from "./transcripts-tool.js";

const { getTranscriptSourceProviderMock, listTranscriptSourceProvidersMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
  listTranscriptSourceProvidersMock: vi.fn(() => []),
}));

vi.mock("../../transcripts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../transcripts/provider-registry.js")>()),
  getTranscriptSourceProvider: getTranscriptSourceProviderMock,
  listTranscriptSourceProviders: listTranscriptSourceProvidersMock,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    caller: origin
      ? {
          kind: "channel",
          channel: origin.channel,
          ...(origin.accountId ? { accountId: origin.accountId } : {}),
          senderId: "test-sender",
          roleIds: [],
        }
      : { kind: "operator", source: "local" },
  });
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

describe("transcripts tool account ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    activeSessions.clear();
    closeOpenClawStateDatabaseForTest();
  });

  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
    listTranscriptSourceProvidersMock.mockClear();
  });

  it("binds account-bound imports to the trusted turn account", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-import-");
    const resolveAccountId = vi.fn(({ source }: { source: { accountId?: string } }) => ({
      ok: true as const,
      value: source.accountId,
    }));
    const importTranscript = vi.fn(async () => [{ text: "trusted import" }]);
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "account-bound-import",
      accessControl: discordAccountOwnership(resolveAccountId),
      name: "Account-bound Import",
      sourceKinds: ["posthoc-transcript"],
      importTranscript,
    });
    const ownerTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-a",
    });

    await ownerTool.execute(
      "call-account-bound-import",
      {
        action: "import",
        providerId: "account-bound-import",
        accountId: "account-b",
        sessionId: "account-bound-import",
        transcript: "trusted import",
      },
      undefined,
      vi.fn(),
    );

    expect(resolveAccountId).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ accountId: "account-a" }) }),
    );
    expect(importTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          source: expect.objectContaining({ accountId: "account-a" }),
        }),
      }),
    );
    await expect(storeFor(stateDir).readSession("account-bound-import")).resolves.toMatchObject({
      source: { accountId: "account-a" },
      metadata: {
        agentId: "main",
      },
    });
  });

  it("binds same-channel capture and lifecycle access to the trusted turn account", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    const stop = vi.fn(async () => ({ ok: true as const, sessionId: "account-bound" }));
    const resolveAccountId = vi.fn(({ source }: { source: { accountId?: string } }) => ({
      ok: true as const,
      value: source.accountId,
    }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accessControl: discordAccountOwnership(resolveAccountId),
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
    expect(resolveAccountId).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ accountId: "account-a" }) }),
    );
    await expect(storeFor(stateDir).readSession("account-bound")).resolves.toMatchObject({
      source: { accountId: "account-a" },
      metadata: {
        agentId: "main",
      },
    });
    expect(result.details).toMatchObject({ accountId: "account-a" });

    const otherAccountTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-b",
    });
    const otherBindingChannelTool = createTool(stateDir, "main", {
      channel: "slack",
      accountId: "account-a",
    });
    const otherRemoteChannelTool = createTool(stateDir, "main", {
      channel: "webchat",
      accountId: "operator",
    });
    await expect(
      otherAccountTool.execute("call-status", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({ details: { active: [] } });
    await expect(
      otherBindingChannelTool.execute(
        "call-other-binding-status",
        { action: "status" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { active: [] } });
    await expect(
      otherRemoteChannelTool.execute(
        "call-other-remote-status",
        { action: "status" },
        undefined,
        vi.fn(),
      ),
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
    ).resolves.toMatchObject({ details: { active: [] } });
    await expect(
      ownerTool.execute("call-provider-missing-owner", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({ details: { active: [] } });
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

    const ownerOnlySession = {
      sessionId: "owner-only",
      source: { providerId: "discord-voice", accountId: "account-a" },
      startedAt: "2026-08-03T12:00:00.000Z",
      stoppedAt: "2026-08-03T12:05:00.000Z",
      metadata: { ownerChannel: "discord", ownerAccountId: "account-a" },
    };
    const store = storeFor(stateDir);
    await store.writeSession(ownerOnlySession);
    await store.appendUtteranceForSession(ownerOnlySession, { text: "owner-only notes" });
    await expect(
      createTool(stateDir, "research", { channel: "webchat", accountId: "operator" }).execute(
        "call-owner-only-other-channel",
        { action: "summarize", sessionId: ownerOnlySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(`transcripts session not found: ${ownerOnlySession.sessionId}`);
    await expect(
      createTool(stateDir, "main").execute(
        "call-owner-only-local",
        { action: "summarize", sessionId: ownerOnlySession.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: ownerOnlySession.sessionId } });
  });

  it.each([
    {
      name: "rejects a trusted account that the provider cannot use",
      resolve: () => ({
        ok: false as const,
        error: 'Discord account "account-a" is not enabled for voice.',
      }),
      error: 'Discord account "account-a" is not enabled for voice.',
    },
    {
      name: "rejects provider redirection away from the trusted account",
      resolve: () => ({ ok: true as const, value: "account-b" }),
      error: 'transcripts provider discord-voice could not use trusted account "account-a"',
    },
  ])("$name before persistence", async ({ resolve, error }) => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    const resolveAccountId = vi.fn(({ source }: { source: { accountId?: string } }) => {
      expect(source.accountId).toBe("account-a");
      return resolve();
    });
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accessControl: discordAccountOwnership(resolveAccountId),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
    });

    await expect(
      createTool(stateDir, "main", { channel: "discord", accountId: "account-a" }).execute(
        "call-invalid-owner",
        {
          action: "start",
          providerId: "discord-voice",
          accountId: "account-b",
          guildId: "guild-a",
          channelId: "voice-a",
          sessionId: "invalid-owner",
        },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(error);
    expect(resolveAccountId).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    await expect(storeFor(stateDir).readSession("invalid-owner")).resolves.toBeUndefined();
  });

  it("preserves explicit accounts for providers outside the turn channel namespace", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
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

  it("starts account-bound providers only from a binding channel or local tool", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accessControl: discordAccountOwnership(),
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
    const crossChannelError =
      "transcripts provider discord-voice can only start from discord or a channel-less local tool";

    await expect(
      createTool(stateDir, "main", { channel: "webchat", accountId: "operator" }).execute(
        "call-webchat",
        { ...startParams, sessionId: "webchat-start" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(crossChannelError);
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
    expect(start).toHaveBeenCalledTimes(2);
    await expect(storeFor(stateDir).readSession("webchat-start")).resolves.toBeUndefined();
  });

  it("does not treat provider lookup aliases as account binding channels", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const meetingAccountId = `meeting\n${"x".repeat(200)}`;
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
        accountId: meetingAccountId,
        meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
        sessionId: "alias-collision",
      },
      undefined,
      vi.fn(),
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          source: expect.objectContaining({ accountId: meetingAccountId }),
        }),
      }),
    );
    expect(result.details).toMatchObject({ accountId: meetingAccountId });
    const text = result.content.find((entry) => entry.type === "text")?.text;
    expect(text?.split("\n")).toHaveLength(3);
    expect(text).not.toContain("x".repeat(65));
    expect(text).toContain('Account: "meeting\\n');
  });

  it("applies provider access to historical rows after the agent boundary", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const store = storeFor(stateDir);
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      aliases: ["discord"],
      accessControl: discordAccountOwnership(),
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
      {
        sessionId: "beta-accountless",
        source: { providerId: "discord-voice" },
        startedAt: "2026-07-04T12:00:00.000Z",
        stoppedAt: "2026-07-04T12:05:00.000Z",
        metadata: { agentId: "main" },
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

    await expect(
      discordTool.execute(
        "call-ownerless-discord",
        { action: "summarize", sessionId: "stable-ownerless" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "stable-ownerless" } });
    await expect(
      webchatTool.execute(
        "call-ownerless-webchat",
        { action: "summarize", sessionId: "stable-ownerless" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: stable-ownerless");
    await expect(
      localMainTool.execute(
        "call-ownerless-local",
        { action: "summarize", sessionId: "stable-ownerless" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "stable-ownerless" } });

    await expect(
      discordTool.execute(
        "call-main-owned-discord",
        { action: "summarize", sessionId: "beta-agent-only" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-agent-only" } });
    await expect(
      webchatTool.execute(
        "call-main-owned-webchat",
        { action: "summarize", sessionId: "beta-agent-only" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-agent-only");
    await expect(
      localMainTool.execute(
        "call-main-owned-local",
        { action: "summarize", sessionId: "beta-agent-only" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-agent-only" } });
    await expect(
      createTool(stateDir, "main", { channel: "discord", accountId: "account-b" }).execute(
        "call-main-owned-wrong-account",
        { action: "summarize", sessionId: "beta-agent-only" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-agent-only");

    const researchLocalTool = createTool(stateDir, "research");
    await expect(
      createTool(stateDir, "research", { channel: "discord", accountId: "account-a" }).execute(
        "call-named-agent-discord",
        { action: "summarize", sessionId: "beta-named-agent" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-named-agent" } });
    await expect(
      createTool(stateDir, "research", { channel: "webchat", accountId: "operator" }).execute(
        "call-named-agent-webchat",
        { action: "summarize", sessionId: "beta-named-agent" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-named-agent");
    await expect(
      researchLocalTool.execute(
        "call-named-agent-local",
        { action: "summarize", sessionId: "beta-named-agent" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-named-agent" } });
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
    ).rejects.toThrow("transcripts session not found: stable-ownerless");
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
    ).rejects.toThrow("transcripts session not found: beta-agent-only");
    await expect(
      webchatTool.execute(
        "call-provider-missing-accountless",
        { action: "summarize", sessionId: "beta-accountless" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-accountless");
    await expect(
      localMainTool.execute(
        "call-provider-missing-accountless-local",
        { action: "summarize", sessionId: "beta-accountless" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-accountless" } });
    await expect(
      createTool(stateDir, "research", { channel: "webchat", accountId: "operator" }).execute(
        "call-provider-missing-named-channel",
        { action: "summarize", sessionId: "beta-named-agent" },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow("transcripts session not found: beta-named-agent");
    await expect(
      createTool(stateDir, "research").execute(
        "call-provider-missing-named-local",
        { action: "summarize", sessionId: "beta-named-agent" },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: "beta-named-agent" } });
  });

  it("preserves main-agent access to ownerless non-binding sessions", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
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

  it("recovers shipped agent-owned account-less sessions only off-channel", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const store = storeFor(stateDir);
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      accessControl: discordAccountOwnership(),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
    });
    const session = {
      sessionId: "beta-main-no-account",
      source: { providerId: "discord-voice" },
      startedAt: "2026-07-03T12:00:00.000Z",
      stoppedAt: "2026-07-03T12:05:00.000Z",
      metadata: { agentId: "main" },
    };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "account-less shipped notes" });

    await expect(
      createTool(stateDir, "main", { channel: "discord", accountId: "account-a" }).execute(
        "call-channel",
        { action: "summarize", sessionId: session.sessionId },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(`transcripts session not found: ${session.sessionId}`);
    await expect(
      createTool(stateDir, "main", { channel: "webchat", accountId: "operator" }).execute(
        "call-other-channel",
        { action: "summarize", sessionId: session.sessionId },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(`transcripts session not found: ${session.sessionId}`);
    await expect(
      createTool(stateDir, "main").execute(
        "call-local",
        { action: "summarize", sessionId: session.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: session.sessionId } });
  });

  it("keeps named-agent ownership authoritative for non-binding sources", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
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

  it("uses provider access for a recorded agent's historical session", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      accessControl: discordAccountOwnership(),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
    });
    const session = {
      sessionId: "partial-research-owner",
      source: { providerId: "discord-voice", accountId: "account-a" },
      startedAt: "2026-08-01T14:00:00.000Z",
      stoppedAt: "2026-08-01T14:05:00.000Z",
      metadata: { agentId: "research", ownerChannel: "discord" },
    };
    const store = storeFor(stateDir);
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, { text: "partial owner notes" });

    await expect(
      createTool(stateDir, "research").execute(
        "call-local-recorded-agent",
        { action: "summarize", sessionId: session.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: session.sessionId } });
    await expect(
      createTool(stateDir, "research", { channel: "discord", accountId: "account-a" }).execute(
        "call-channel-recorded-agent",
        { action: "summarize", sessionId: session.sessionId },
        undefined,
        vi.fn(),
      ),
    ).resolves.toMatchObject({ details: { sessionId: session.sessionId } });
    await expect(
      createTool(stateDir, "main").execute(
        "call-local-main",
        { action: "summarize", sessionId: session.sessionId },
        undefined,
        vi.fn(),
      ),
    ).rejects.toThrow(`transcripts session not found: ${session.sessionId}`);
  });

  it("does not stop a same-millisecond replacement owned by another account", async () => {
    const stateDir = tempDirs.make("openclaw-transcripts-account-");
    const start = vi.fn(async (request) => ({ ok: true as const, session: request.session }));
    const stop = vi.fn(async (request) => ({ ok: true as const, sessionId: request.sessionId }));
    getTranscriptSourceProviderMock.mockReturnValue({
      id: "discord-voice",
      accessControl: discordAccountOwnership(({ source }) => ({
        ok: true,
        value: source.accountId ?? "account-a",
      })),
      name: "Discord Voice",
      sourceKinds: ["live-audio"],
      start,
      stop,
    } satisfies TranscriptSourceProvider);
    const config = {
      transcripts: {
        enabled: true,
        autoStart: [
          {
            providerId: "discord-voice",
            sessionId: "account-bound-auto-start",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        ],
      },
    };
    const service = createTranscriptsAutoStartService({
      config,
      stateDir,
      logger: { warn: vi.fn() },
    });
    const ownerTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-a",
    });
    const otherAccountTool = createTool(stateDir, "main", {
      channel: "discord",
      accountId: "account-b",
    });

    service.start();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const autoStarted = await storeFor(stateDir).readSession("account-bound-auto-start");
    if (!autoStarted) {
      throw new Error("expected the configured capture to start");
    }
    await expect(
      otherAccountTool.execute("other-status", { action: "status" }, undefined, vi.fn()),
    ).resolves.toMatchObject({ details: { active: [] } });
    await ownerTool.execute(
      "owner-stop",
      { action: "stop", sessionId: "account-bound-auto-start" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ accountId: "account-a" }) }),
    );

    stop.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(autoStarted.startedAt));
    await otherAccountTool.execute(
      "replacement-start",
      {
        action: "start",
        providerId: "discord-voice",
        sessionId: "account-bound-auto-start",
      },
      undefined,
      vi.fn(),
    );
    const selector = `${autoStarted.startedAt.slice(0, 10)}/account-bound-auto-start`;
    await service.stop();
    expect(stop).not.toHaveBeenCalled();
    const replacement = await storeFor(stateDir).readSession(selector);
    expect(replacement).toMatchObject({ source: { accountId: "account-b" } });
    expect(replacement?.stoppedAt).toBeUndefined();
    await otherAccountTool.execute(
      "replacement-stop",
      { action: "stop", sessionId: "account-bound-auto-start" },
      undefined,
      vi.fn(),
    );
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ accountId: "account-b" }) }),
    );
  });
});
