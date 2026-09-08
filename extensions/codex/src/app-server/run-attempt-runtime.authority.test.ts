import { describe, expect, it } from "vitest";
import {
  assertScheduledCodexAppAuthorityRuntime,
  buildScheduledCodexAppServerConnectionIdentity,
} from "./scheduled-app-authority.js";
import { canResolveScheduledConfiguredMcpCreatorAuthority } from "./scheduled-configured-mcp-authority.js";

const eligible = {
  trigger: "user",
  connectionClass: "local-loopback",
  bindingKind: "session",
  bindingSessionKey: "agent:main:main",
  sessionKey: "agent:main:main",
  usesSupervisionConnection: false,
  preservesNativeModel: false,
  senderIsOwner: true,
  hasStaticConfiguredMcp: true,
} as const;

describe("canResolveScheduledConfiguredMcpCreatorAuthority", () => {
  it("admits only the positive local durable operator case", () => {
    expect(canResolveScheduledConfiguredMcpCreatorAuthority(eligible)).toBe(true);
  });

  it.each([
    ["non-user trigger", { trigger: "cron" }],
    ["non-loopback connection", { connectionClass: "remote" }],
    ["non-session binding", { bindingKind: "supervision" }],
    ["missing durable binding key", { bindingSessionKey: undefined }],
    ["incognito session", { sessionKey: "agent:main:dashboard:incognito-test" }],
    ["supervision", { usesSupervisionConnection: true }],
    ["preserved native model", { preservesNativeModel: true }],
    ["non-owner", { senderIsOwner: false }],
    ["external sender", { senderId: "sender-1" }],
    ["input provenance", { inputProvenance: { kind: "external_user" } }],
    ["trusted handoff", { trustedInternalHandoff: { kind: "completion" } }],
    ["spawn lineage", { spawnedBy: "agent:main:parent" }],
    ["scheduled policy", { scheduledToolPolicy: { version: 1 } }],
    ["no static configured MCP", { hasStaticConfiguredMcp: false }],
  ])("rejects %s", (_label, override) => {
    expect(canResolveScheduledConfiguredMcpCreatorAuthority({ ...eligible, ...override })).toBe(
      false,
    );
  });
});

const scheduledAuthority = {
  version: 1 as const,
  runtimeId: "codex",
  namespace: "codex.apps",
  payload: {
    version: 1,
    auth: { profileId: "openai:work", accountId: "account-1" },
    apps: [],
  },
};

function scheduledConnection(overrides: Record<string, unknown> = {}) {
  return {
    usesSupervisionConnection: false,
    appServer: { start: { homeScope: "agent" } },
    startupPreparedAuth: {
      kind: "profile",
      profileId: "openai:work",
      snapshot: {
        loginParams: {
          type: "chatgptAuthTokens",
          accessToken: "token",
          chatgptAccountId: "account-1",
        },
        chatgptAccountId: "account-1",
        secretFreeCacheKey: "profile-key",
      },
    },
    ...overrides,
  } as never;
}

describe("assertScheduledCodexAppAuthorityRuntime", () => {
  it("admits the exact cron prepared-profile principal", () => {
    expect(() =>
      assertScheduledCodexAppAuthorityRuntime(scheduledConnection(), {
        trigger: "cron",
        scheduledRuntimeAuthority: scheduledAuthority,
      }),
    ).not.toThrow();
  });

  it.each([
    ["endpoint URL rotation", { url: "wss://other.example.com" }, {}],
    ["endpoint removal", { transport: "stdio", url: undefined }, { connectionClass: "local" }],
    ["remote workspace rotation", {}, { remoteWorkspaceRoot: "/different-workspace" }],
  ])("continues across account rotation but rejects %s", (_name, startOverride, serverOverride) => {
    const appServer = {
      start: {
        transport: "websocket",
        homeScope: "agent",
        command: "codex",
        args: [] as string[],
        headers: {},
        url: "wss://codex.example.com/app-server",
      },
      connectionClass: "remote",
    } as const;
    const connectionIdentity = buildScheduledCodexAppServerConnectionIdentity(appServer);
    const configuredAuthority = {
      ...scheduledAuthority,
      payload: {
        ...scheduledAuthority.payload,
        auth: {
          kind: "configured-app-server",
          connectionFingerprint: connectionIdentity,
          managedRequirementsFingerprint: "managed-requirements",
        },
      },
    };
    expect(
      buildScheduledCodexAppServerConnectionIdentity({
        ...appServer,
        start: {
          ...appServer.start,
          authToken: "rotated",
          headers: { Authorization: "Bearer rotated" },
        },
      }),
    ).toBe(connectionIdentity);

    // Configured authority is endpoint-owned; prepared-profile accounts do not
    // replace it when the endpoint is reauthenticated between scheduled runs.
    for (const accountId of [undefined, "account-1", "account-2"]) {
      expect(() =>
        assertScheduledCodexAppAuthorityRuntime(
          scheduledConnection({
            appServer,
            startupPreparedAuth: accountId
              ? {
                  kind: "profile",
                  profileId: "openai:work",
                  snapshot: {
                    loginParams: { type: "chatgptAuthTokens" },
                    chatgptAccountId: accountId,
                  },
                }
              : undefined,
          }),
          { trigger: "cron", scheduledRuntimeAuthority: configuredAuthority },
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertScheduledCodexAppAuthorityRuntime(
        scheduledConnection({
          appServer: {
            ...appServer,
            ...serverOverride,
            start: { ...appServer.start, ...startOverride },
          },
          startupPreparedAuth: undefined,
        }),
        { trigger: "cron", scheduledRuntimeAuthority: configuredAuthority },
      ),
    ).toThrow("different configured Codex app-server");
  });

  it.each([
    ["ordinary turn", {}, { trigger: "user" }],
    ["supervision", { usesSupervisionConnection: true }, {}],
    ["user-scoped home", { appServer: { start: { homeScope: "user" } } }, {}],
    [
      "different profile",
      {
        startupPreparedAuth: {
          kind: "profile",
          profileId: "openai:other",
          snapshot: {
            loginParams: { type: "chatgptAuthTokens" },
            chatgptAccountId: "account-1",
          },
        },
      },
      {},
    ],
    [
      "different account",
      {
        startupPreparedAuth: {
          kind: "profile",
          profileId: "openai:work",
          snapshot: {
            loginParams: { type: "chatgptAuthTokens" },
            chatgptAccountId: "account-2",
          },
        },
      },
      {},
    ],
    ["API-key route", { startupPreparedAuth: { kind: "api-key", apiKey: "key" } }, {}],
  ] as const)("fails closed for %s", (_name, connectionOverrides, paramsOverrides) => {
    expect(() =>
      assertScheduledCodexAppAuthorityRuntime(scheduledConnection(connectionOverrides), {
        trigger: "cron",
        scheduledRuntimeAuthority: scheduledAuthority,
        ...paramsOverrides,
      }),
    ).toThrow(/Reauthorize|Restore the profile/);
  });
});
