import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import {
  createActivityHandler as baseCreateActivityHandler,
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { createMSTeamsSsoTokenStoreMemory } from "./sso-token-store.js";
import {
  type MSTeamsSsoFetch,
  handleSigninTokenExchangeInvoke,
  handleSigninVerifyStateInvoke,
  parseSigninTokenExchangeValue,
  parseSigninVerifyStateValue,
} from "./sso.js";

function createActivityHandler() {
  const run = vi.fn(async () => undefined);
  const handler = baseCreateActivityHandler(run);
  return { handler, run };
}

function createDepsWithoutSso(
  overrides: Partial<MSTeamsMessageHandlerDeps> = {},
): MSTeamsMessageHandlerDeps {
  const base = createMSTeamsMessageHandlerDeps();
  return { ...base, ...overrides };
}

function createSsoDeps(params: { fetchImpl: MSTeamsSsoFetch }) {
  const tokenStore = createMSTeamsSsoTokenStoreMemory();
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "bf-service-token"),
  };
  return {
    sso: {
      tokenProvider,
      tokenStore,
      connectionName: "GraphConnection",
      fetchImpl: params.fetchImpl,
    },
    tokenStore,
    tokenProvider,
  };
}

function createRegisteredSsoHandler(sso: MSTeamsMessageHandlerDeps["sso"]) {
  const deps = createDepsWithoutSso({ sso });
  const { handler } = createActivityHandler();
  const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  return { deps, registered };
}

function createSigninInvokeContext(params: {
  name: "signin/tokenExchange" | "signin/verifyState";
  value: unknown;
  userAadId?: string;
  userBfId?: string;
  conversationId?: string;
  conversationType?: "personal" | "groupChat" | "channel";
  teamId?: string;
  channelName?: string;
}): MSTeamsTurnContext & { sendActivity: ReturnType<typeof vi.fn> } {
  const conversationType = params.conversationType ?? "personal";
  const conversationId =
    params.conversationId ??
    (conversationType === "personal"
      ? "19:personal-chat"
      : conversationType === "channel"
        ? "19:channel@thread.tacv2"
        : "19:group@thread.tacv2");

  return {
    activity: {
      id: "invoke-1",
      type: "invoke",
      name: params.name,
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: params.userBfId ?? "bf-user",
        aadObjectId: params.userAadId ?? "aad-user-guid",
        name: "Test User",
      },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      attachments: [],
      value: params.value,
    },
    sendActivity: vi.fn(async () => ({ id: "ack-id" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "update" })),
    deleteActivity: vi.fn(async () => {}),
  } as unknown as MSTeamsTurnContext & {
    sendActivity: ReturnType<typeof vi.fn>;
  };
}

function createFakeFetch(handlers: Array<(url: string, init?: unknown) => unknown>) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl: MSTeamsSsoFetch = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error("unexpected fetch call");
    }
    const response = handler(url, init) as {
      ok: boolean;
      status: number;
      body: unknown;
    };
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
      text: async () =>
        typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""),
    };
  };
  return { fetchImpl, calls };
}

function expectInvokeResponse(sendActivity: ReturnType<typeof vi.fn>, status?: number): void {
  const activity = sendActivity.mock.calls.find(([arg]) => {
    return (
      typeof arg === "object" &&
      arg !== null &&
      (arg as { type?: unknown }).type === "invokeResponse"
    );
  })?.[0] as { value?: { status?: unknown } } | undefined;

  expect(activity).toBeDefined();
  if (status !== undefined) {
    expect(activity?.value?.status).toBe(status);
  }
}

function expectLogFields(logFn: unknown, message: string, fields: Record<string, unknown>): void {
  const calls = (logFn as { mock?: { calls?: Array<[unknown, unknown?]> } }).mock?.calls;
  expect(calls).toBeDefined();
  const call = calls?.find(([text]) => text === message);
  expect(call).toBeDefined();
  const meta = call?.[1] as Record<string, unknown> | undefined;
  expect(meta).toBeDefined();
  for (const [key, value] of Object.entries(fields)) {
    expect(meta?.[key]).toEqual(value);
  }
}

function createBlockedSigninScenarios() {
  return [
    {
      name: "DM sender outside allowlist",
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        userAadId: "blocked-dm-aad",
      },
      expectedDropLog: "dropping signin invoke (dm sender not allowlisted)",
    },
    {
      name: "channel outside route allowlist",
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["blocked-channel-aad"],
            teams: {
              "team-allowlisted": {
                channels: {
                  "19:allowlisted@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        userAadId: "blocked-channel-aad",
        conversationType: "channel" as const,
        conversationId: "19:blocked-channel@thread.tacv2",
        teamId: "team-blocked",
        channelName: "General",
      },
      expectedDropLog: "dropping signin invoke (not in team/channel allowlist)",
    },
    {
      name: "group sender outside group allowlist",
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        userAadId: "blocked-group-aad",
        conversationType: "groupChat" as const,
        conversationId: "19:group-chat@thread.v2",
      },
      expectedDropLog: "dropping signin invoke (group sender not allowlisted)",
    },
  ];
}

describe("msteams signin invoke value parsers", () => {
  it("parses signin/tokenExchange values", () => {
    expect(
      parseSigninTokenExchangeValue({
        id: "flow-1",
        connectionName: "Graph",
        token: "eyJ...",
      }),
    ).toEqual({ id: "flow-1", connectionName: "Graph", token: "eyJ..." });
  });

  it("rejects non-object signin/tokenExchange values", () => {
    expect(parseSigninTokenExchangeValue(null)).toBeNull();
    expect(parseSigninTokenExchangeValue("nope")).toBeNull();
  });

  it("parses signin/verifyState values", () => {
    expect(parseSigninVerifyStateValue({ state: "123456" })).toEqual({ state: "123456" });
    expect(parseSigninVerifyStateValue({})).toEqual({ state: undefined });
    expect(parseSigninVerifyStateValue(null)).toBeNull();
  });
});

describe("handleSigninTokenExchangeInvoke", () => {
  it("exchanges the Teams token and persists the result", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result).toEqual({
      ok: true,
      token: "delegated-graph-token",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/usertoken/exchange");
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[0]?.url).toContain("connectionName=GraphConnection");
    expect(calls[0]?.url).toContain("channelId=msteams");

    const init = calls[0]?.init as {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer bf-service-token");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({ token: "exchangeable-token" });

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
    expect(stored?.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("returns a service error when the User Token service rejects the exchange", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ ok: false, status: 502, body: "bad gateway" }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_error");
      expect(result.status).toBe(502);
      expect(result.message).toContain("bad gateway");
    }
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored).toBeNull();
  });

  it("refuses to exchange without a user id", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "", channelId: "msteams" },
      deps: sso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_user");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("handleSigninVerifyStateInvoke", () => {
  it("fetches the user token for the magic code and persists it", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-2",
          expiration: "2031-02-03T04:05:06Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninVerifyStateInvoke({
      value: { state: "654321" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/api/usertoken/GetToken");
    expect(calls[0]?.url).toContain("code=654321");
    const init = calls[0]?.init as { method?: string };
    expect(init?.method).toBe("GET");

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-2");
  });

  it("rejects invocations without a state code", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const result = await handleSigninVerifyStateInvoke({
      value: { state: "   " },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_state");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("msteams signin invoke handler registration", () => {
  beforeAll(() => {
    installMSTeamsTestRuntime();
  });

  const blockedSigninScenarios = createBlockedSigninScenarios();
  const invokeVariants = [
    {
      name: "signin/tokenExchange" as const,
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    },
    {
      name: "signin/verifyState" as const,
      value: { state: "112233" },
    },
  ];

  it("acks signin invokes even when sso is not configured", async () => {
    const deps = createDepsWithoutSso();
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "Graph", token: "exchangeable" },
    });

    await registered.run(ctx);

    expectInvokeResponse(ctx.sendActivity, 200);
    expect(run).not.toHaveBeenCalled();
    expectLogFields(deps.log.debug, "signin invoke received but msteams.sso is not configured", {
      name: "signin/tokenExchange",
    });
  });

  for (const invoke of invokeVariants) {
    for (const scenario of blockedSigninScenarios) {
      it(`does not process ${invoke.name} for ${scenario.name}`, async () => {
        const { fetchImpl, calls } = createFakeFetch([
          () => ({
            ok: true,
            status: 200,
            body: {
              channelId: "msteams",
              connectionName: "GraphConnection",
              token: "delegated-graph-token",
              expiration: "2030-01-01T00:00:00Z",
            },
          }),
        ]);
        const { sso, tokenStore } = createSsoDeps({ fetchImpl });
        const deps = createDepsWithoutSso({ cfg: scenario.cfg, sso });
        const { handler } = createActivityHandler();
        const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
          run: NonNullable<MSTeamsActivityHandler["run"]>;
        };

        const ctx = createSigninInvokeContext({
          name: invoke.name,
          value: invoke.value,
          ...scenario.context,
        });

        await registered.run(ctx);

        expectInvokeResponse(ctx.sendActivity, 200);
        expect(calls).toHaveLength(0);
        const stored = await tokenStore.get({
          connectionName: "GraphConnection",
          userId: scenario.context.userAadId ?? "aad-user-guid",
        });
        expect(stored).toBeNull();
        expectLogFields(deps.log.debug, scenario.expectedDropLog, { name: invoke.name });
      });
    }
  }

  it("invokes the token exchange handler when sso is configured", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const { deps, registered } = createRegisteredSsoHandler(sso);

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    });

    await registered.run(ctx);

    expectInvokeResponse(ctx.sendActivity, 200);
    expectLogFields(deps.log.info, "msteams sso token exchanged", {
      userId: "aad-user-guid",
      hasExpiry: true,
    });
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
  });

  it("logs an error when the token exchange fails", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ ok: false, status: 400, body: "bad request" }),
    ]);
    const { sso } = createSsoDeps({ fetchImpl });
    const { deps, registered } = createRegisteredSsoHandler(sso);

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    });

    await registered.run(ctx);

    expectInvokeResponse(ctx.sendActivity);
    expectLogFields(deps.log.error, "msteams sso token exchange failed", {
      code: "unexpected_response",
      status: 400,
    });
  });

  it("handles signin/verifyState via the magic-code flow", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-3",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/verifyState",
      value: { state: "112233" },
    });

    await registered.run(ctx);

    expectLogFields(deps.log.info, "msteams sso verifyState succeeded", {
      userId: "aad-user-guid",
    });
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-3");
  });
});
