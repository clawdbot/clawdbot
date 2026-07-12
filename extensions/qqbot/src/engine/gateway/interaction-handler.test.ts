// Qqbot tests cover interaction handler plugin behavior.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSdkAccessAdapter } from "../../bridge/sdk-adapter.js";
import { registerPlatformAdapter, type PlatformAdapter } from "../adapter/index.js";
import type { InteractionEvent } from "../types.js";
import { createInteractionHandler } from "./interaction-handler.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const acknowledgeInteractionMock = vi.hoisted(() => vi.fn(async () => undefined));
const sendTextMock = vi.hoisted(() => vi.fn(async () => ({ id: "message-1", timestamp: 1 })));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: (account: GatewayAccount) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  acknowledgeInteraction: acknowledgeInteractionMock,
  sendText: sendTextMock,
}));

const appliedApprovalResult = {
  applied: true,
  approval: {
    id: "exec:abc12345",
    urlPath: "/approve/exec%3Aabc12345",
    createdAtMs: 1,
    expiresAtMs: 10_000,
    presentation: {
      kind: "exec",
      commandText: "echo approved",
      allowedDecisions: ["allow-once", "deny"],
    },
    status: "allowed",
    decision: "allow-once",
    resolvedAtMs: 2,
    reason: "user",
  },
} satisfies ApprovalResolveResult;

const resolveApprovalMock = vi.fn(
  async (): Promise<ApprovalResolveResult> => appliedApprovalResult,
);
const expectedApprovalResolve = {
  approvalId: "exec:abc12345",
  approvalKind: "exec",
  decision: "allow-once",
} as const;

function makeAccount(config: GatewayAccount["config"] = {}): GatewayAccount {
  return {
    accountId: "default",
    appId: "app",
    clientSecret: "secret",
    markdownSupport: false,
    config,
  };
}

const account = makeAccount();

const runtime = {} as GatewayPluginRuntime;

function makeRestrictedCfg(approvers: string[]): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "app",
        clientSecret: "secret",
        execApprovals: {
          enabled: true,
          approvers,
        },
      },
    },
  } as OpenClawConfig;
}

function makeCommandAuthorizedFallbackCfg(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "app",
        clientSecret: "secret",
        allowFrom: ["ATTACKER_OPENID"],
      },
    },
  } as OpenClawConfig;
}

function makeApprovalEvent(overrides: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    id: "interaction-1",
    type: 11,
    chat_type: 1,
    group_openid: "group-1",
    group_member_openid: "ATTACKER_OPENID",
    version: 1,
    data: {
      type: 11,
      resolved: {
        button_data: "approve:v2:exec:exec%3Aabc12345:allow-once",
        user_id: "ATTACKER_USER_ID",
      },
    },
    ...overrides,
  };
}

function installPlatformAdapter(): void {
  registerPlatformAdapter({
    validateRemoteUrl: vi.fn(async () => undefined),
    resolveSecret: vi.fn(async (value: unknown) => (typeof value === "string" ? value : undefined)),
    downloadFile: vi.fn(async () => "/tmp/file"),
    fetchMedia: vi.fn(async () => {
      throw new Error("unused");
    }),
    getTempDir: () => "/tmp",
    hasConfiguredSecret: (value: unknown) => typeof value === "string" && value.length > 0,
    normalizeSecretInputString: (value: unknown) => (typeof value === "string" ? value : undefined),
    resolveSecretInputString: ({ value }: { value: unknown }) =>
      typeof value === "string" ? value : undefined,
    resolveApproval: resolveApprovalMock,
  } as PlatformAdapter);
}

describe("createInteractionHandler approval buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveApprovalMock.mockResolvedValue(appliedApprovalResult);
    installPlatformAdapter();
  });

  it("rejects approval button clicks from users outside the configured approvers", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("does not authorize from resolved user id when the actor openid is not approved", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(
      makeApprovalEvent({
        data: {
          type: 11,
          resolved: {
            button_data: "approve:v2:exec:exec%3Aabc12345:allow-once",
            user_id: "OWNER_OPENID",
          },
        },
      }),
    );

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("resolves approval button clicks from configured approvers", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(makeApprovalEvent({ group_member_openid: "OWNER_OPENID" }));

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith(expectedApprovalResolve),
    );
  });

  it("preserves plugin ownership through configured-approver authorization", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(
      makeApprovalEvent({
        group_member_openid: "OWNER_OPENID",
        data: {
          type: 11,
          resolved: {
            button_data: "approve:v2:plugin:exec%3Alooks-like-exec%2F1:deny",
            user_id: "ATTACKER_USER_ID",
          },
        },
      }),
    );

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith({
        approvalId: "exec:looks-like-exec/1",
        approvalKind: "plugin",
        decision: "deny",
      }),
    );
  });

  it("rejects plugin approval buttons from users outside the configured approvers", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(
      makeApprovalEvent({
        data: {
          type: 11,
          resolved: {
            button_data: "approve:v2:plugin:exec%3Alooks-like-exec%2F1:deny",
            user_id: "ATTACKER_USER_ID",
          },
        },
      }),
    );

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("logs the canonical winner when another surface already resolved", async () => {
    resolveApprovalMock.mockResolvedValueOnce({
      applied: false,
      approval: {
        id: "exec:abc12345",
        urlPath: "/approve/exec%3Aabc12345",
        createdAtMs: 1,
        expiresAtMs: 10_000,
        presentation: {
          kind: "exec",
          commandText: "echo approved",
          allowedDecisions: ["allow-once", "deny"],
        },
        status: "denied",
        decision: "deny",
        resolvedAtMs: 2,
        reason: "user",
      },
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const handler = createInteractionHandler(account, runtime, log, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(makeApprovalEvent({ group_member_openid: "OWNER_OPENID" }));

    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        "Approval already resolved: id=exec:abc12345, status=denied, decision=deny",
      ),
    );
    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "Approval response received." },
    );
    expect(sendTextMock).toHaveBeenCalledWith(
      { type: "group", id: "group-1" },
      "This approval was already resolved: Denied.",
      { appId: "app", clientSecret: "secret" },
      { msgId: undefined },
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("decision=allow-once"));
    expect(log.error).not.toHaveBeenCalled();
  });

  it("acknowledges before a slow canonical resolution completes", async () => {
    let releaseResolution!: (result: ApprovalResolveResult) => void;
    resolveApprovalMock.mockImplementationOnce(
      async () =>
        await new Promise<ApprovalResolveResult>((resolve) => {
          releaseResolution = resolve;
        }),
    );
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(makeApprovalEvent({ group_member_openid: "OWNER_OPENID" }));

    await vi.waitFor(() =>
      expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
        { appId: "app", clientSecret: "secret" },
        "interaction-1",
        0,
        { content: "Approval response received." },
      ),
    );
    await vi.waitFor(() => expect(resolveApprovalMock).toHaveBeenCalled());
    expect(sendTextMock).not.toHaveBeenCalled();

    releaseResolution(appliedApprovalResult);
    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalled());
  });

  it("uses the direct user openid when a group member openid is unavailable", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(
      makeApprovalEvent({
        chat_type: 2,
        group_openid: undefined,
        group_member_openid: undefined,
        user_openid: "OWNER_OPENID",
      }),
    );

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith(expectedApprovalResolve),
    );
  });

  it("resolves fallback approval buttons from explicit command-authorized senders", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeCommandAuthorizedFallbackCfg(),
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith(expectedApprovalResolve),
    );
  });

  it("delegates fallback approval button auth to the gateway command resolver", async () => {
    const access = createSdkAccessAdapter();
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () =>
        ({
          accessGroups: {
            operators: {
              type: "message.senders",
              members: {
                qqbot: ["ATTACKER_OPENID"],
              },
            },
          },
          channels: {
            qqbot: {
              appId: "app",
              clientSecret: "secret",
              allowFrom: ["accessGroup:operators"],
            },
          },
        }) as OpenClawConfig,
      resolveCommandAuthorized: (params) => access.resolveSlashCommandAuthorization(params),
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith(expectedApprovalResolve),
    );
  });

  it("uses merged account config for fallback button command auth", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () =>
        ({
          channels: {
            qqbot: {
              appId: "app",
              clientSecret: "secret",
              accounts: {
                default: {
                  allowFrom: ["ATTACKER_OPENID"],
                },
              },
            },
          },
        }) as OpenClawConfig,
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith(expectedApprovalResolve),
    );
  });

  it("rejects fallback approval buttons from senders without explicit command auth", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () =>
        ({
          channels: {
            qqbot: {
              appId: "app",
              clientSecret: "secret",
              allowFrom: ["OWNER_OPENID"],
            },
          },
        }) as OpenClawConfig,
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no allowlist",
      {
        channels: {
          qqbot: {
            appId: "app",
            clientSecret: "secret",
          },
        },
      },
    ],
    [
      "wildcard allowlist",
      {
        channels: {
          qqbot: {
            appId: "app",
            clientSecret: "secret",
            allowFrom: ["*"],
          },
        },
      },
    ],
  ] satisfies Array<[string, OpenClawConfig]>)(
    "rejects fallback approval buttons when %s does not grant command auth",
    async (_name, cfg) => {
      const handler = createInteractionHandler(account, runtime, undefined, {
        getActiveCfg: () => cfg,
      });

      handler(makeApprovalEvent());

      await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

      expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
        { appId: "app", clientSecret: "secret" },
        "interaction-1",
        0,
        { content: "You are not authorized to approve this request." },
      );
      expect(resolveApprovalMock).not.toHaveBeenCalled();
    },
  );

  it("rejects fallback approval buttons without a trusted actor id", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeCommandAuthorizedFallbackCfg(),
    });

    handler(makeApprovalEvent({ group_member_openid: undefined, user_openid: undefined }));

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("rejects approval button clicks when active config cannot be loaded", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => {
        throw new Error("config unavailable");
      },
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "Approval is unavailable." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });
});
