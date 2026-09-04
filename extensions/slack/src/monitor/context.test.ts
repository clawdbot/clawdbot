// Slack tests cover context plugin behavior.
import type { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "../runtime.js";
import { createSlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";

const saveRemoteMediaMock = vi.hoisted(() => vi.fn());
const logVerboseMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  logVerbose: logVerboseMock,
}));

vi.mock("./media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.runtime.js")>()),
  saveRemoteMedia: saveRemoteMediaMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createTestContext(params?: {
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  groupDmEnabled?: boolean;
  groupDmChannels?: string[];
  appClient?: App["client"];
  runtime?: RuntimeEnv;
  apiAppId?: string;
  channelsConfig?: Record<string, { enabled?: boolean }>;
}) {
  return createSlackMonitorContext({
    cfg: {
      channels: { slack: { enabled: true } },
      session: { dmScope: params?.dmScope ?? "main" },
    } as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app: { client: params?.appClient ?? {} } as App,
    runtime: params?.runtime ?? ({} as RuntimeEnv),
    botUserId: "U_BOT",
    botId: "B_BOT",
    identityHealth: { lifecycle: "ready", lastError: null },
    teamId: "T_EXPECTED",
    apiAppId: params?.apiAppId ?? "A_EXPECTED",
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: false,
    groupDmEnabled: params?.groupDmEnabled ?? false,
    groupDmChannels: params?.groupDmChannels ?? [],
    defaultRequireMention: true,
    channelsConfig: params?.channelsConfig,
    groupPolicy: "allowlist",
    useAccessGroups: true,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    threadHistoryScope: "thread",
    threadInheritParent: false,
    slashCommand: {
      enabled: true,
      name: "openclaw",
      ephemeral: true,
      sessionPrefix: "slack:slash",
    },
    textLimit: 4000,
    typingReaction: "",
    ackReactionScope: "group-mentions",
    mediaMaxBytes: 20 * 1024 * 1024,
  });
}

function createEnterpriseEventScope(teamId: string): SlackEventScope {
  return {
    teamId,
    client: {} as SlackEventScope["client"],
  };
}

beforeEach(() => {
  setSlackRuntime(null as never);
  saveRemoteMediaMock.mockReset();
  logVerboseMock.mockClear();
});
afterEach(() => setSlackRuntime(null as never));

describe("createSlackMonitorContext shouldDropMismatchedSlackEvent", () => {
  it("drops mismatched top-level app/team identifiers", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_WRONG",
        team_id: "T_EXPECTED",
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });

  it("drops mismatched nested team.id payloads used by interaction bodies", () => {
    const ctx = createTestContext();
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_WRONG" },
      }),
    ).toBe(true);
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_EXPECTED",
        team: { id: "T_EXPECTED" },
      }),
    ).toBe(false);
  });

  it("reads updated identity fields and mismatch guards after auth recovery", () => {
    const ctx = createTestContext();

    ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_ENTERPRISE",
      enterpriseId: "E_ENTERPRISE",
    };
    ctx.teamId = "";
    ctx.apiAppId = "A_ENTERPRISE";

    expect(ctx.installationIdentity).toEqual({
      kind: "enterprise",
      apiAppId: "A_ENTERPRISE",
      enterpriseId: "E_ENTERPRISE",
    });
    expect(ctx.teamId).toBe("");
    expect(ctx.apiAppId).toBe("A_ENTERPRISE");
    expect(ctx.shouldDropMismatchedSlackEvent({ api_app_id: "A_EXPECTED" })).toBe(true);

    ctx.installationIdentity = {
      kind: "workspace",
      apiAppId: "A_RECOVERED",
      teamId: "T_RECOVERED",
    };
    ctx.teamId = "T_RECOVERED";
    ctx.apiAppId = "A_RECOVERED";

    expect(ctx.teamId).toBe("T_RECOVERED");
    expect(ctx.apiAppId).toBe("A_RECOVERED");
    expect(
      ctx.shouldDropMismatchedSlackEvent({
        api_app_id: "A_RECOVERED",
        team_id: "T_WRONG",
      }),
    ).toBe(true);
  });
});

describe("createSlackMonitorContext isChannelAllowed", () => {
  it("normalizes channel-prefixed group DM allowlist entries", () => {
    const ctx = createTestContext({
      groupDmEnabled: true,
      groupDmChannels: ["channel:G456"],
    });

    expect(ctx.isChannelAllowed({ channelId: "G456", channelType: "mpim" })).toBe(true);
    expect(ctx.isChannelAllowed({ channelId: "G999", channelType: "mpim" })).toBe(false);
  });

  it("matches workspace-qualified channel and group DM policies", () => {
    const ctx = createTestContext({
      groupDmEnabled: true,
      groupDmChannels: ["team:T11111111:channel:G01234567"],
      channelsConfig: {
        "team:T11111111:channel:C01234567": { enabled: true },
        "team:T22222222:channel:C01234567": { enabled: false },
      },
    });

    expect(
      ctx.isChannelAllowed({
        teamId: "T11111111",
        channelId: "C01234567",
        channelType: "channel",
      }),
    ).toBe(true);
    expect(
      ctx.isChannelAllowed({
        teamId: "T22222222",
        channelId: "C01234567",
        channelType: "channel",
      }),
    ).toBe(false);
    expect(
      ctx.isChannelAllowed({
        teamId: "T11111111",
        channelId: "G01234567",
        channelType: "mpim",
      }),
    ).toBe(true);
    expect(
      ctx.isChannelAllowed({
        teamId: "T22222222",
        channelId: "G01234567",
        channelType: "mpim",
      }),
    ).toBe(false);
  });
});

describe("createSlackMonitorContext resolveSlackSystemEventRoute", () => {
  it("routes threaded interaction events to the Slack thread session", () => {
    const ctx = createTestContext();

    expect(
      ctx.resolveSlackSystemEventRoute({
        channelId: "C_THREAD",
        channelType: "channel",
        senderId: "U_CLICKER",
        threadTs: "1712345678.123456",
      }),
    ).toEqual({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:c_thread:thread:1712345678.123456",
    });
  });

  it("routes channel-less direct interactions to the sender session", () => {
    const ctx = createTestContext({ dmScope: "per-channel-peer" });

    expect(
      ctx.resolveSlackSystemEventRoute({
        channelType: "im",
        senderId: "U_SHORTCUT",
      }),
    ).toEqual({ agentId: "main", sessionKey: "agent:main:slack:direct:u_shortcut" });
  });

  it("routes typeless system events through an event-carried mpDM type", () => {
    const ctx = createTestContext();
    ctx.rememberSlackChannelType("C0MPDM42", "mpim");

    expect(
      ctx.resolveSlackSystemEventRoute({
        channelId: "C0MPDM42",
        senderId: "U_ACTOR",
      }),
    ).toEqual({ agentId: "main", sessionKey: "agent:main:slack:group:c0mpdm42" });
  });

  it("partitions enterprise channel system events by workspace", () => {
    const ctx = createTestContext();
    const resolveForTeam = (teamId: string) =>
      ctx.resolveSlackSystemEventRoute({
        channelId: "C_SHARED",
        channelType: "channel",
        senderId: "U_ACTOR",
        eventScope: createEnterpriseEventScope(teamId),
      });

    expect(resolveForTeam("T111")).toEqual({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:team:t111:channel:c_shared",
    });
    expect(resolveForTeam("T222")).toEqual({
      agentId: "main",
      sessionKey: "agent:main:slack:channel:team:t222:channel:c_shared",
    });
  });

  it("partitions enterprise main DM system events by workspace", () => {
    const ctx = createTestContext({ dmScope: "main" });
    const resolveForTeam = (teamId: string) =>
      ctx.resolveSlackSystemEventRoute({
        channelId: "D_SHARED",
        channelType: "im",
        senderId: "U_SHARED",
        eventScope: createEnterpriseEventScope(teamId),
      });

    expect(resolveForTeam("T111")).toEqual({
      agentId: "main",
      sessionKey: "agent:main:main:account:default:team:t111",
    });
    expect(resolveForTeam("T222")).toEqual({
      agentId: "main",
      sessionKey: "agent:main:main:account:default:team:t222",
    });
  });
});

describe("createSlackMonitorContext channel metadata cache", () => {
  it("fills metadata after an event stored only the authoritative type", async () => {
    const info = vi.fn().mockResolvedValue({
      channel: {
        id: "C0MPDM42",
        name: "team-chat",
        topic: { value: "planning" },
      },
    });
    const ctx = createTestContext({
      appClient: { conversations: { info } } as unknown as App["client"],
    });
    ctx.rememberSlackChannelType("C0MPDM42", "mpim");

    await expect(ctx.resolveChannelName("C0MPDM42")).resolves.toEqual({
      name: "team-chat",
      type: "mpim",
      topic: "planning",
      purpose: undefined,
    });
    await ctx.resolveChannelName("C0MPDM42");
    expect(info).toHaveBeenCalledOnce();
  });

  it("isolates remembered types by enterprise team scope", async () => {
    const createScope = (teamId: string): SlackEventScope =>
      ({
        teamId,
        client: {
          conversations: { info: vi.fn().mockRejectedValue(new Error("missing_scope")) },
        },
      }) as unknown as SlackEventScope;
    const ctx = createTestContext();
    const firstTeam = createScope("T_FIRST");
    const secondTeam = createScope("T_SECOND");
    ctx.rememberSlackChannelType("C0SHARED", "mpim", firstTeam);

    await expect(ctx.resolveChannelName("C0SHARED", firstTeam)).resolves.toMatchObject({
      type: "mpim",
    });
    await expect(ctx.resolveChannelName("C0SHARED", secondTeam)).resolves.toEqual({});
    await expect(ctx.resolveChannelName("C0SHARED")).resolves.toEqual({});
  });

  it("evicts the oldest authoritative type when the bounded cache fills", async () => {
    const info = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const ctx = createTestContext({
      appClient: { conversations: { info } } as unknown as App["client"],
    });
    ctx.rememberSlackChannelType("C0OLDEST", "mpim");
    for (let index = 0; index < 1024; index += 1) {
      ctx.rememberSlackChannelType(`C${index}`, "channel");
    }

    await expect(ctx.resolveChannelName("C0OLDEST")).resolves.toEqual({});
  });

  it("evicts the oldest user name when the bounded user cache fills", async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      user: { profile: { display_name: "test-user" } },
    });
    const ctx = createTestContext({
      appClient: { users: { info: usersInfo } } as unknown as App["client"],
    });
    await ctx.resolveUserName("U0OLDEST");
    for (let index = 0; index < 2048; index += 1) {
      await ctx.resolveUserName(`U${index}`);
    }
    // U0OLDEST should have been evicted by the fill. Re-requesting it must
    // call users.info again (cache miss) instead of returning a stale entry.
    await ctx.resolveUserName("U0OLDEST");
    expect(usersInfo).toHaveBeenCalledTimes(2050);
  });

  it("keeps a recently re-resolved user while older entries are evicted", async () => {
    const usersInfo = vi.fn().mockImplementation(async ({ user }: { user: string }) => ({
      user: { profile: { display_name: `name-${user}` } },
    }));
    const ctx = createTestContext({
      appClient: { users: { info: usersInfo } } as unknown as App["client"],
    });
    await ctx.resolveUserName("U0KEEP");
    for (let index = 0; index < 2047; index += 1) {
      await ctx.resolveUserName(`U${index}`);
    }
    // Touch U0KEEP so it becomes newest before the final insert that would
    // otherwise push the original insertion past the 2048-entry bound.
    await ctx.resolveUserName("U0KEEP");
    await ctx.resolveUserName("U_NEW");
    const before = usersInfo.mock.calls.length;
    await expect(ctx.resolveUserName("U0KEEP")).resolves.toEqual({ name: "name-U0KEEP" });
    expect(usersInfo).toHaveBeenCalledTimes(before);
  });

  it("downloads the cached DM profile image without blocking or attaching the bot token", async () => {
    const download = deferred<{ path: string }>();
    saveRemoteMediaMock.mockReturnValue(download.promise);
    const usersInfo = vi.fn().mockResolvedValue({
      user: {
        profile: {
          display_name: "Alice",
          image_192: "https://avatars.slack-edge.com/user-hash-192.png",
          image_512: "https://avatars.slack-edge.com/user-hash-512.png",
          image_72: "https://avatars.slack-edge.com/user-hash-72.png",
        },
      },
    });
    const ctx = createTestContext({
      appClient: { users: { info: usersInfo } } as unknown as App["client"],
    });

    await expect(ctx.resolveUserName("U1")).resolves.toEqual({
      name: "Alice",
      imageUrl: "https://avatars.slack-edge.com/user-hash-192.png",
    });
    expect(ctx.resolveUserAvatar("U1")).toBeUndefined();
    expect(ctx.resolveUserAvatar("U1")).toBeUndefined();
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(saveRemoteMediaMock).toHaveBeenCalledWith({
      url: "https://avatars.slack-edge.com/user-hash-192.png",
      filePathHint: "conversation-avatar.png",
      maxBytes: 256 * 1024,
      ssrfPolicy: {
        allowedHostnames: ["avatars.slack-edge.com", "*.slack-edge.com"],
        hostnameAllowlist: ["avatars.slack-edge.com", "*.slack-edge.com"],
      },
    });

    download.resolve({ path: "/media/inbound/slack-avatar.png" });
    await vi.waitFor(() =>
      expect(ctx.resolveUserAvatar("U1")).toBe("/media/inbound/slack-avatar.png"),
    );
    await ctx.resolveUserName("U1");
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  it("skips profile image downloads for GovSlack clients", async () => {
    const usersInfo = vi.fn().mockResolvedValue({
      user: {
        profile: {
          display_name: "Gov User",
          image_192: "https://avatars.slack-edge.com/gov-user.png",
        },
      },
    });
    const appClient = {
      slackApiUrl: "https://slack-gov.com/api/",
      users: { info: usersInfo },
    } as unknown as App["client"];
    const ctx = createTestContext({ appClient });

    await ctx.resolveUserName("U_GOV");

    expect(ctx.resolveUserAvatar("U_GOV")).toBeUndefined();
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });
});

describe("createSlackMonitorContext Agent View state", () => {
  it("records Agent View in the account context without runtime state", async () => {
    const ctx = createTestContext();

    await expect(ctx.isSlackAgentView()).resolves.toBe(false);
    await ctx.recordSlackAgentView();
    await expect(ctx.isSlackAgentView()).resolves.toBe(true);
  });

  it("persists and restores Agent View through plugin state", async () => {
    const stored = new Map<string, { experience: "agent"; observedAt: number }>();
    const register = vi.fn(
      async (key: string, value: { experience: "agent"; observedAt: number }) => {
        stored.set(key, value);
      },
    );
    const lookup = vi.fn(async (key: string) => stored.get(key));
    const openKeyedStore = vi.fn(() => ({ register, lookup }));
    setSlackRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    const first = createTestContext();
    await first.recordSlackAgentView();
    const restarted = createTestContext();

    const stateKey = JSON.stringify(["workspace", "default", "T_EXPECTED", "A_EXPECTED"]);
    expect(register).toHaveBeenCalledWith(stateKey, {
      experience: "agent",
      observedAt: expect.any(Number),
    });
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "agent-view-workspaces",
      maxEntries: 4096,
    });
    await expect(restarted.isSlackAgentView()).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith(stateKey);

    const replacementApp = createTestContext({ apiAppId: "A_REPLACEMENT" });
    await expect(replacementApp.isSlackAgentView()).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledWith(
      JSON.stringify(["workspace", "default", "T_EXPECTED", "A_REPLACEMENT"]),
    );
  });

  it("persists managed view roots without enabling unrelated DM threads", async () => {
    const stored = new Map<
      string,
      { experience: "agent" | "managed-thread"; observedAt: number }
    >();
    const register = vi.fn(
      async (
        key: string,
        value: { experience: "agent" | "managed-thread"; observedAt: number },
      ) => {
        stored.set(key, value);
      },
    );
    const lookup = vi.fn(async (key: string) => stored.get(key));
    const openKeyedStore = vi.fn(() => ({ register, lookup }));
    setSlackRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    const first = createTestContext();
    await first.recordSlackManagedViewThread("D123", "10.000");
    const restarted = createTestContext();

    await expect(restarted.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(true);
    await expect(restarted.isSlackManagedViewThread("D123", "20.000")).resolves.toBe(false);

    const stateKey = JSON.stringify([
      "thread",
      "default",
      "T_EXPECTED",
      "A_EXPECTED",
      "D123",
      "10.000",
    ]);
    expect(register).toHaveBeenCalledWith(stateKey, {
      experience: "managed-thread",
      observedAt: expect.any(Number),
    });
    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "agent-view-threads",
      maxEntries: 4096,
    });
    expect(lookup).toHaveBeenCalledWith(stateKey);
  });

  it("retries opening managed view state after a transient failure", async () => {
    const register = vi.fn(async () => undefined);
    const openKeyedStore = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("sqlite unavailable");
      })
      .mockImplementation(() => ({ register, lookup: vi.fn() }));
    setSlackRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    const ctx = createTestContext();

    await ctx.recordSlackManagedViewThread("D123", "10.000");
    await ctx.recordSlackManagedViewThread("D123", "10.000");

    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledOnce();
  });

  it("retries managed view persistence after a transient write failure", async () => {
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("sqlite busy"))
      .mockResolvedValue(undefined);
    setSlackRuntime({
      state: { openKeyedStore: vi.fn(() => ({ register, lookup: vi.fn() })) },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    const ctx = createTestContext();

    await ctx.recordSlackManagedViewThread("D123", "10.000");
    await ctx.recordSlackManagedViewThread("D123", "10.000");

    expect(register).toHaveBeenCalledTimes(2);
  });

  it("does not cache negative managed view root lookups", async () => {
    const lookup = vi.fn(async () => undefined);
    setSlackRuntime({
      state: { openKeyedStore: vi.fn(() => ({ register: vi.fn(), lookup })) },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    const ctx = createTestContext();

    await expect(ctx.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(false);
    await expect(ctx.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(false);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest managed view root from the bounded memory cache", async () => {
    const lookup = vi.fn(async () => ({
      experience: "managed-thread" as const,
      observedAt: Date.now(),
    }));
    setSlackRuntime({
      state: { openKeyedStore: vi.fn(() => ({ register: vi.fn(), lookup })) },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    const ctx = createTestContext();

    await ctx.isSlackManagedViewThread("D123", "oldest");
    for (let index = 0; index < 4096; index += 1) {
      await ctx.isSlackManagedViewThread("D123", `thread-${index}`);
    }
    await ctx.isSlackManagedViewThread("D123", "oldest");

    expect(lookup).toHaveBeenCalledTimes(4098);
  });

  it("reads the durable Agent View marker once the app id is learned", async () => {
    const register = vi.fn();
    const lookup = vi.fn(async () => ({ experience: "agent", observedAt: 1 }));
    setSlackRuntime({
      state: { openKeyedStore: vi.fn(() => ({ register, lookup })) },
    } as never);
    const ctx = createTestContext({ apiAppId: "" });

    await expect(ctx.isSlackAgentView()).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();

    ctx.apiAppId = "A_LEARNED";
    await expect(ctx.isSlackAgentView()).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith(
      JSON.stringify(["workspace", "default", "T_EXPECTED", "A_LEARNED"]),
    );
  });

  it("does not persist Agent View without a stable Slack app identity", async () => {
    const register = vi.fn();
    const lookup = vi.fn();
    setSlackRuntime({
      state: { openKeyedStore: vi.fn(() => ({ register, lookup })) },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    const ctx = createTestContext({ apiAppId: "" });
    await ctx.recordSlackAgentView();
    await ctx.recordSlackManagedViewThread("D123", "10.000");
    await expect(ctx.isSlackAgentView()).resolves.toBe(true);
    await expect(ctx.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(true);
    expect(register).not.toHaveBeenCalled();

    const restarted = createTestContext({ apiAppId: "" });
    await expect(restarted.isSlackAgentView()).resolves.toBe(false);
    await expect(restarted.isSlackManagedViewThread("D123", "10.000")).resolves.toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps event-derived Agent View when persistent state cannot open", async () => {
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);
    const ctx = createTestContext();

    await ctx.recordSlackAgentView();

    await expect(ctx.isSlackAgentView()).resolves.toBe(true);
  });
});

describe("Slack session status and titles", () => {
  it.each(["processing", "active", "suspended"] as const)(
    "writes %s only for a thread",
    async (status) => {
      const apiCall = vi.fn().mockResolvedValue({ ok: true });
      const ctx = createTestContext({ appClient: { apiCall } as unknown as App["client"] });
      await ctx.setSlackSessionStatus({ channelId: "D123", status });
      expect(apiCall).not.toHaveBeenCalled();
      await ctx.setSlackSessionStatus({ channelId: "D123", threadTs: "10.000", status });
      expect(apiCall).toHaveBeenCalledExactlyOnceWith("agents.sessions.setStatus", {
        token: "xoxb-test",
        channel_id: "D123",
        thread_ts: "10.000",
        status,
      });
    },
  );

  it("warns operators only once across contexts for a missing Stop subscription", async () => {
    const warning = "missing_agent_session_stopped_event_subscription";
    const log = vi.fn();
    const apiCall = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, response_metadata: { warnings: [warning] } })
      .mockResolvedValue({ ok: true, warning });
    for (let i = 0; i < 3; i++) {
      const ctx = createTestContext({
        appClient: { apiCall } as unknown as App["client"],
        runtime: { log } as unknown as RuntimeEnv,
      });
      await ctx.setSlackSessionStatus({
        channelId: "D123",
        threadTs: "10.000",
        status: "processing",
      });
    }
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "https://docs.openclaw.ai/channels/slack#additional-manifest-settings",
      ),
    );
  });

  it("keeps API failures verbose and retries a title only after successful delivery", async () => {
    const apiCall = vi
      .fn()
      .mockRejectedValueOnce(new Error("not_agent_app"))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("rename failed"))
      .mockResolvedValue({ ok: true });
    const log = vi.fn();
    const ctx = createTestContext({
      appClient: { apiCall } as unknown as App["client"],
      runtime: { log } as unknown as RuntimeEnv,
    });
    const update = {
      channelId: "D123",
      threadTs: "10.000",
      status: "processing" as const,
      title: "Research",
    };
    await ctx.setSlackSessionStatus(update);
    await ctx.setSlackSessionStatus(update);
    await ctx.setSlackSessionStatus(update);
    await ctx.setSlackSessionStatus(update);
    expect(
      apiCall.mock.calls.filter(([method]) => method === "agents.sessions.rename"),
    ).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
    expect(logVerboseMock).toHaveBeenCalledWith(expect.stringContaining("not_agent_app"));
    expect(logVerboseMock).toHaveBeenCalledWith(expect.stringContaining("rename failed"));
  });

  it("accepts the creation title, renames once per change, and does not echo user renames", async () => {
    const apiCall = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, title: "x".repeat(200) })
      .mockResolvedValue({ ok: true });
    const ctx = createTestContext({ appClient: { apiCall } as unknown as App["client"] });
    const update = { channelId: "D123", threadTs: "10.000", status: "processing" as const };
    await ctx.setSlackSessionStatus({ ...update, title: "x".repeat(201) });
    await ctx.setSlackSessionStatus({ ...update, title: "x".repeat(202) });
    await ctx.setSlackSessionStatus({ ...update, title: "New display name" });
    await ctx.setSlackSessionStatus({ ...update, title: "New display name" });
    ctx.recordSlackSessionTitle({ ...update, title: "User title" });
    await ctx.setSlackSessionStatus({ ...update, title: "User title" });
    expect(apiCall).toHaveBeenNthCalledWith(
      1,
      "agents.sessions.setStatus",
      expect.objectContaining({ title: "x".repeat(200) }),
    );
    expect(apiCall.mock.calls.filter(([method]) => method === "agents.sessions.rename")).toEqual([
      [
        "agents.sessions.rename",
        { token: "xoxb-test", channel_id: "D123", thread_ts: "10.000", title: "New display name" },
      ],
    ]);
  });

  it("does not overwrite a user rename received during a status request", async () => {
    const statusReply = deferred<{ ok: boolean }>();
    const apiCall = vi
      .fn()
      .mockReturnValueOnce(statusReply.promise)
      .mockResolvedValue({ ok: true });
    const ctx = createTestContext({ appClient: { apiCall } as unknown as App["client"] });
    const update = { channelId: "D123", threadTs: "10.000", status: "processing" as const };
    const pending = ctx.setSlackSessionStatus({ ...update, title: "Old title" });
    ctx.recordSlackSessionTitle({ ...update, title: "User title" });
    statusReply.resolve({ ok: true });
    await pending;
    await ctx.setSlackSessionStatus({ ...update, title: "User title" });
    expect(apiCall.mock.calls.map(([method]) => method)).toEqual([
      "agents.sessions.setStatus",
      "agents.sessions.setStatus",
    ]);
  });

  it("evicts old title records without mixing threads or workspace clients", async () => {
    const apiCall = vi.fn().mockResolvedValue({ ok: true });
    const ctx = createTestContext();
    const eventScope = { teamId: "T_OTHER", client: { apiCall } as unknown as App["client"] };
    const update = {
      channelId: "D123",
      threadTs: "10.000",
      status: "processing" as const,
      title: "Title",
      eventScope,
    };
    ctx.recordSlackSessionTitle(update);
    for (let i = 0; i < 1024; i++) {
      ctx.recordSlackSessionTitle({ ...update, threadTs: String(i) });
    }
    await ctx.setSlackSessionStatus(update);
    expect(apiCall).toHaveBeenLastCalledWith(
      "agents.sessions.rename",
      expect.objectContaining({ thread_ts: "10.000", title: "Title" }),
    );
    ctx.recordSlackSessionTitle({
      ...update,
      eventScope: undefined,
      title: "Workspace-local title",
    });
    await ctx.setSlackSessionStatus(update);
    expect(
      apiCall.mock.calls.filter(([method]) => method === "agents.sessions.rename"),
    ).toHaveLength(1);
  });
});
