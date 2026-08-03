// Tests approval command behavior for pending tool and execution requests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelApprovalCapability,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { markImplicitSameChatApprovalAuthorization } from "../../plugin-sdk/approval-auth-runtime.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleApproveCommand } from "./commands-approve.js";
import type { HandleCommandsParams } from "./commands-types.js";

const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/approval-gateway-resolver.js", () => ({
  resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function approvalResolverRequest(callIndex = 0) {
  const call = resolveApprovalOverGatewayMock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected approval resolver call ${callIndex}`);
  }
  return requireRecord(call[0], `approval resolver call ${callIndex} request`);
}

function expectApprovalResolverCall(params: {
  callIndex?: number;
  method: string;
  id: string;
  decision?: string;
}) {
  const request = approvalResolverRequest(params.callIndex ?? 0);
  expect(request).toHaveProperty("cfg");
  expect(request).toHaveProperty("senderId");
  expect(request.approvalId).toBe(params.id);
  expect(request.decision).toBe(params.decision ?? "allow-once");
  expect(request.resolveMethod).toBe(
    params.method === "plugin.approval.resolve" ? "plugin" : "exec",
  );
  expect(request.clientDisplayName).toMatch(/^Chat approval \(.+\)$/);
}

type ApprovalKind = "exec" | "plugin";
type ApprovalTestPolicy = Partial<
  Record<ApprovalKind, { authorizedSenders: readonly string[]; accountId?: string; reply?: string }>
>;

const approvalPolicies = new WeakMap<OpenClawConfig, ApprovalTestPolicy>();

function withApprovalPolicy(cfg: OpenClawConfig, policy: ApprovalTestPolicy): OpenClawConfig {
  approvalPolicies.set(cfg, policy);
  return cfg;
}

const createApprovalCapability = (channelLabel: string): ChannelApprovalCapability => ({
  authorizeActorAction: ({ cfg, accountId, senderId, approvalKind }) => {
    const policy = approvalPolicies.get(cfg)?.[approvalKind];
    if (!policy) {
      return markImplicitSameChatApprovalAuthorization({ authorized: true });
    }
    if (
      senderId &&
      policy.authorizedSenders.includes(senderId) &&
      (!policy.accountId || policy.accountId === accountId)
    ) {
      return { authorized: true };
    }
    return {
      authorized: false,
      reason: `❌ You are not authorized to approve ${approvalKind} requests on ${channelLabel}.`,
    };
  },
  resolveApproveCommandBehavior: ({ cfg, approvalKind }) => {
    const reply = approvalPolicies.get(cfg)?.[approvalKind]?.reply;
    return reply ? { kind: "reply", text: reply } : undefined;
  },
});

function createApprovalTestPlugin(id: string, label: string, approvals = false): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id, label }),
    approvalCapability: approvals ? createApprovalCapability(label) : undefined,
  };
}

const telegramApproveTestPlugin = createApprovalTestPlugin("telegram", "Telegram", true);
telegramApproveTestPlugin.config.defaultAccountId = (cfg) =>
  cfg.channels?.telegram?.defaultAccount ?? "default";
const discordApproveTestPlugin = createApprovalTestPlugin("discord", "Discord", true);
const signalApproveTestPlugin = createApprovalTestPlugin("signal", "Signal", true);
const slackApproveTestPlugin = createApprovalTestPlugin("slack", "Slack");
const whatsappApproveTestPlugin = createApprovalTestPlugin("whatsapp", "WhatsApp");

function setApprovePluginRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "discord", plugin: discordApproveTestPlugin, source: "test" },
      { pluginId: "slack", plugin: slackApproveTestPlugin, source: "test" },
      { pluginId: "whatsapp", plugin: whatsappApproveTestPlugin, source: "test" },
      { pluginId: "signal", plugin: signalApproveTestPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramApproveTestPlugin, source: "test" },
    ]),
  );
}

function buildApproveParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
  ctxOverrides?: {
    Provider?: string;
    Surface?: string;
    SenderId?: string;
    GatewayClientScopes?: string[];
    AccountId?: string;
  },
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "whatsapp";
  return {
    cfg,
    ctx: {
      Provider: provider,
      Surface: ctxOverrides?.Surface ?? provider,
      CommandSource: "text",
      SenderId: ctxOverrides?.SenderId,
      GatewayClientScopes: ctxOverrides?.GatewayClientScopes,
      AccountId: ctxOverrides?.AccountId,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: ctxOverrides?.SenderId ?? "owner",
      channel: provider,
      channelId: provider,
    },
  } as unknown as HandleCommandsParams;
}

describe("handleApproveCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApprovePluginRegistry();
  });

  function createTelegramApproveCfg(
    execApprovals: {
      enabled: boolean;
      approvers: string[];
      target: "dm";
    } | null = { enabled: true, approvers: ["123"], target: "dm" },
  ): OpenClawConfig {
    return withApprovalPolicy(
      {
        commands: { text: true },
        channels: {
          telegram: {
            allowFrom: ["*"],
            ...(execApprovals ? { execApprovals } : {}),
          },
        },
      } as OpenClawConfig,
      {
        exec: {
          authorizedSenders: execApprovals?.approvers ?? [],
          ...(execApprovals?.enabled
            ? {}
            : { reply: "❌ Telegram exec approvals are not enabled for this bot account." }),
        },
        plugin: { authorizedSenders: execApprovals?.approvers ?? [] },
      },
    );
  }

  function createDiscordApproveCfg(
    execApprovals: {
      enabled: boolean;
      approvers: string[];
      target: "dm" | "channel" | "both";
    } | null = { enabled: true, approvers: ["123"], target: "channel" },
  ): OpenClawConfig {
    return withApprovalPolicy(
      {
        commands: { text: true },
        channels: {
          discord: {
            allowFrom: ["*"],
            ...(execApprovals ? { execApprovals } : {}),
          },
        },
      } as OpenClawConfig,
      {
        exec: { authorizedSenders: execApprovals?.approvers ?? [] },
        plugin: { authorizedSenders: execApprovals?.approvers ?? [] },
      },
    );
  }

  it("rejects invalid usage", async () => {
    const result = await handleApproveCommand(
      buildApproveParams("/approve", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Usage: /approve");
  });

  it.each([
    {
      name: "submits approval",
      commandBody: "/approve abc allow-once",
      cfg: {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      ctx: { SenderId: "123" },
      authorized: true,
      method: "exec.approval.resolve",
      id: "abc",
    },
    {
      name: "accepts bare approve text for Slack-style manual approvals",
      commandBody: "approve abc allow-once",
      cfg: {
        commands: { text: true },
        channels: { slack: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      ctx: { Provider: "slack", Surface: "slack", SenderId: "U123" },
      authorized: true,
      method: "exec.approval.resolve",
      id: "abc",
    },
    {
      name: "accepts Telegram /approve from configured approvers even when chat access is otherwise blocked",
      commandBody: "/approve abc12345 allow-once",
      cfg: createTelegramApproveCfg(),
      ctx: { Provider: "telegram", Surface: "telegram", SenderId: "123" },
      authorized: false,
      method: "exec.approval.resolve",
      id: "abc12345",
    },
    {
      name: "accepts forwarded Telegram plugin approvals from approvers when native delivery is disabled",
      commandBody: "/approve plugin:abc12345 allow-once",
      cfg: createTelegramApproveCfg({ enabled: false, approvers: ["123"], target: "dm" }),
      ctx: { Provider: "telegram", Surface: "telegram", SenderId: "123" },
      authorized: false,
      method: "plugin.approval.resolve",
      id: "plugin:abc12345",
    },
    {
      name: "accepts Signal /approve from configured approvers even when chat access is otherwise blocked",
      commandBody: "/approve abc12345 allow-once",
      cfg: withApprovalPolicy(
        {
          commands: { text: true },
          channels: { signal: { allowFrom: ["+15551230000"] } },
        } as OpenClawConfig,
        {
          exec: { authorizedSenders: ["+15551230000"] },
          plugin: { authorizedSenders: ["+15551230000"] },
        },
      ),
      ctx: { Provider: "signal", Surface: "signal", SenderId: "+15551230000" },
      authorized: false,
      method: "exec.approval.resolve",
      id: "abc12345",
    },
    {
      name: "keeps same-chat /approve available to authorized senders when helper approvers are empty",
      commandBody: "/approve abc12345 allow-once",
      cfg: {
        commands: { text: true },
        channels: { signal: { allowFrom: [] } },
      } as OpenClawConfig,
      ctx: { Provider: "signal", Surface: "signal", SenderId: "+15551239999" },
      authorized: true,
      method: "exec.approval.resolve",
      id: "abc12345",
    },
    {
      name: "accepts Telegram /approve from exec target recipients when native approvals are disabled",
      commandBody: "/approve abc12345 allow-once",
      cfg: withApprovalPolicy(
        {
          commands: { text: true },
          approvals: {
            exec: {
              enabled: true,
              mode: "targets",
              targets: [{ channel: "telegram", to: "123" }],
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          exec: { authorizedSenders: ["123"] },
          plugin: { authorizedSenders: [] },
        },
      ),
      ctx: { Provider: "telegram", Surface: "telegram", SenderId: "123" },
      authorized: false,
      method: "exec.approval.resolve",
      id: "abc12345",
    },
  ] as const)("$name", async ({ commandBody, cfg, ctx, authorized, method, id }) => {
    const params = buildApproveParams(commandBody, cfg, ctx);
    params.command.isAuthorizedSender = authorized;
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expectApprovalResolverCall({ method, id });
  });

  it("honors the configured default account for omitted-account /approve auth", async () => {
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
    const params = buildApproveParams(
      "/approve abc12345 allow-once",
      withApprovalPolicy(
        {
          commands: { text: true },
          channels: {
            telegram: {
              defaultAccount: "work",
              allowFrom: ["*"],
              accounts: {
                work: {
                  execApprovals: { enabled: true, approvers: ["123"], target: "dm" },
                },
              },
            },
          },
        } as OpenClawConfig,
        {
          exec: { authorizedSenders: ["123"], accountId: "work" },
          plugin: { authorizedSenders: ["123"], accountId: "work" },
        },
      ),
      {
        Provider: "telegram",
        Surface: "telegram",
        SenderId: "123",
        AccountId: undefined,
      },
    );
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expectApprovalResolverCall({ method: "exec.approval.resolve", id: "abc12345" });
  });

  it.each([
    {
      name: "does not treat implicit default approval auth as a bypass for unauthorized senders",
      cfg: { commands: { text: true } } as OpenClawConfig,
      ctx: { Provider: "webchat", Surface: "webchat", SenderId: "123" },
      setup: undefined,
    },
    {
      name: "does not treat implicit same-chat approval auth as a bypass for unauthorized senders",
      cfg: {
        commands: { text: true },
        channels: { slack: { allowFrom: ["*"] } },
      } as OpenClawConfig,
      ctx: { Provider: "slack", Surface: "slack", SenderId: "U123" },
      setup: () =>
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "slack",
              plugin: {
                ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
                approvalCapability: {
                  authorizeActorAction: () => ({ authorized: true }),
                  getActionAvailabilityState: () => ({ kind: "disabled" }),
                },
              },
              source: "test",
            },
          ]),
        ),
    },
    {
      name: "does not allow empty helper approvers to bypass unauthorized sender checks",
      cfg: {
        commands: { text: true },
        channels: { signal: { allowFrom: [] } },
      } as OpenClawConfig,
      ctx: { Provider: "signal", Surface: "signal", SenderId: "+15551239999" },
      setup: undefined,
    },
  ] as const)("$name", async ({ cfg, ctx, setup }) => {
    setup?.();
    const params = buildApproveParams("/approve abc12345 allow-once", cfg, ctx);
    params.command.isAuthorizedSender = false;

    const result = await handleApproveCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
  });

  it("requires configured Discord approvers for exec approvals", async () => {
    for (const testCase of [
      {
        name: "discord no approver policy",
        cfg: createDiscordApproveCfg(null),
        senderId: "123",
        expectedText: "not authorized to approve",
        expectedResolverCalls: 0,
      },
      {
        name: "discord non approver",
        cfg: createDiscordApproveCfg({ enabled: true, approvers: ["999"], target: "channel" }),
        senderId: "123",
        expectedText: "not authorized to approve",
        expectedResolverCalls: 0,
      },
      {
        name: "discord approver with rich client disabled",
        cfg: createDiscordApproveCfg({ enabled: false, approvers: ["123"], target: "channel" }),
        senderId: "123",
        expectedText: "Approval allow-once submitted",
        expectedResolverCalls: 1,
        expectedMethod: "exec.approval.resolve",
      },
      {
        name: "discord approver",
        cfg: createDiscordApproveCfg({ enabled: true, approvers: ["123"], target: "channel" }),
        senderId: "123",
        expectedText: "Approval allow-once submitted",
        expectedResolverCalls: 1,
        expectedMethod: "exec.approval.resolve",
      },
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      if (testCase.expectedResolverCalls > 0) {
        resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
      }
      const result = await handleApproveCommand(
        buildApproveParams("/approve abc12345 allow-once", testCase.cfg, {
          Provider: "discord",
          Surface: "discord",
          SenderId: testCase.senderId,
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(resolveApprovalOverGatewayMock, testCase.name).toHaveBeenCalledTimes(
        testCase.expectedResolverCalls,
      );
      if ("expectedMethod" in testCase && testCase.expectedMethod) {
        expectApprovalResolverCall({
          method: testCase.expectedMethod,
          id: "abc12345",
        });
      }
    }
  });

  it("rejects approval probing on Discord when neither kind is authorized", async () => {
    for (const testCase of [
      {
        name: "discord legacy plugin approval with exec approvals disabled",
        cfg: createDiscordApproveCfg(null),
        senderId: "123",
      },
      {
        name: "discord legacy plugin approval for non approver",
        cfg: createDiscordApproveCfg({ enabled: true, approvers: ["999"], target: "channel" }),
        senderId: "123",
      },
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
      const result = await handleApproveCommand(
        buildApproveParams("/approve legacy-plugin-123 allow-once", testCase.cfg, {
          Provider: "discord",
          Surface: "discord",
          SenderId: testCase.senderId,
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain("not authorized to approve");
      expect(resolveApprovalOverGatewayMock, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("probes authorized legacy kinds explicitly without inferring from the id", async () => {
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );
    resolveApprovalOverGatewayMock.mockResolvedValueOnce(undefined);
    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve legacy-plugin-123 allow-once",
        createDiscordApproveCfg({ enabled: true, approvers: ["123"], target: "channel" }),
        {
          Provider: "discord",
          Surface: "discord",
          SenderId: "123",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Approval allow-once submitted");
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(2);
    expectApprovalResolverCall({
      callIndex: 1,
      method: "plugin.approval.resolve",
      id: "legacy-plugin-123",
    });
  });

  it("returns the underlying not-found error for plugin-only approval routing", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          plugin: {
            ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
            approvalCapability: {
              authorizeActorAction: ({ approvalKind }: { approvalKind: "exec" | "plugin" }) =>
                approvalKind === "plugin"
                  ? { authorized: true }
                  : {
                      authorized: false,
                      reason: "❌ You are not authorized to approve exec requests on Matrix.",
                    },
            },
          },
          source: "test",
        },
      ]),
    );
    resolveApprovalOverGatewayMock.mockRejectedValueOnce(
      new Error("unknown or expired approval id"),
    );

    const result = await handleApproveCommand(
      buildApproveParams(
        "/approve abc123 allow-once",
        {
          commands: { text: true },
          channels: { matrix: { allowFrom: ["*"] } },
        } as OpenClawConfig,
        {
          Provider: "matrix",
          Surface: "matrix",
          SenderId: "123",
        },
      ),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Failed to submit approval");
    expect(result?.reply?.text).toContain("unknown or expired approval id");
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(1);
    expectApprovalResolverCall({ method: "plugin.approval.resolve", id: "abc123" });
  });

  it("requires configured Discord approvers before probing either kind", async () => {
    for (const testCase of [
      {
        name: "discord non approver",
        cfg: createDiscordApproveCfg({ enabled: false, approvers: ["999"], target: "channel" }),
        senderId: "123",
        expectedText: "not authorized to approve",
        expectedResolverCalls: 0,
      },
      {
        name: "discord plugin approver",
        cfg: createDiscordApproveCfg({ enabled: false, approvers: ["123"], target: "channel" }),
        senderId: "123",
        expectedText: "Approval allow-once submitted",
        expectedResolverCalls: 2,
      },
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      if (testCase.expectedResolverCalls > 0) {
        resolveApprovalOverGatewayMock
          .mockRejectedValueOnce(new Error("unknown or expired approval id"))
          .mockResolvedValueOnce(undefined);
      }
      const result = await handleApproveCommand(
        buildApproveParams("/approve plugin:abc123 allow-once", testCase.cfg, {
          Provider: "discord",
          Surface: "discord",
          SenderId: testCase.senderId,
        }),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(resolveApprovalOverGatewayMock, testCase.name).toHaveBeenCalledTimes(
        testCase.expectedResolverCalls,
      );
      if (testCase.expectedResolverCalls > 0) {
        expectApprovalResolverCall({ method: "exec.approval.resolve", id: "plugin:abc123" });
        expectApprovalResolverCall({
          callIndex: 1,
          method: "plugin.approval.resolve",
          id: "plugin:abc123",
        });
      }
    }
  });

  it("rejects unauthorized or invalid Telegram /approve variants", async () => {
    for (const testCase of [
      {
        name: "different bot mention",
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve@otherbot abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        expectedText: "targets a different Telegram bot",
        expectResolverCalls: 0,
      },
      {
        name: "unknown approval id",
        cfg: createTelegramApproveCfg(),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        setup: () =>
          resolveApprovalOverGatewayMock.mockRejectedValue(
            new Error("unknown or expired approval id"),
          ),
        expectedText: "unknown or expired approval id",
        expectResolverCalls: 2,
      },
      {
        name: "telegram disabled native delivery reports the channel-disabled message",
        cfg: createTelegramApproveCfg(null),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        expectedText: "Telegram exec approvals are not enabled",
        expectResolverCalls: 0,
      },
      {
        name: "non approver",
        cfg: createTelegramApproveCfg({ enabled: true, approvers: ["999"], target: "dm" }),
        commandBody: "/approve abc12345 allow-once",
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        },
        expectedText: "not authorized to approve",
        expectResolverCalls: 0,
      },
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      testCase.setup?.();
      const result = await handleApproveCommand(
        buildApproveParams(testCase.commandBody, testCase.cfg, testCase.ctx),
        true,
      );
      expect(result?.shouldContinue, testCase.name).toBe(false);
      expect(result?.reply?.text, testCase.name).toContain(testCase.expectedText);
      expect(resolveApprovalOverGatewayMock, testCase.name).toHaveBeenCalledTimes(
        testCase.expectResolverCalls,
      );
    }
  });

  it("enforces gateway approval scopes", async () => {
    const cfg = {
      commands: { text: true },
    } as OpenClawConfig;
    for (const testCase of [
      {
        scopes: ["operator.write"],
        expectedText: "requires operator.approvals",
        expectedResolverCalls: 0,
      },
      {
        scopes: ["operator.approvals"],
        expectedText: "Approval allow-once submitted",
        expectedResolverCalls: 1,
      },
      {
        scopes: ["operator.admin"],
        expectedText: "Approval allow-once submitted",
        expectedResolverCalls: 1,
      },
    ] as const) {
      resolveApprovalOverGatewayMock.mockReset();
      resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
      const result = await handleApproveCommand(
        buildApproveParams("/approve abc allow-once", cfg, {
          Provider: "webchat",
          Surface: "webchat",
          GatewayClientScopes: [...testCase.scopes],
        }),
        true,
      );

      expect(result?.shouldContinue, String(testCase.scopes)).toBe(false);
      expect(result?.reply?.text, String(testCase.scopes)).toContain(testCase.expectedText);
      expect(resolveApprovalOverGatewayMock, String(testCase.scopes)).toHaveBeenCalledTimes(
        testCase.expectedResolverCalls,
      );
      if (testCase.expectedResolverCalls > 0) {
        expectApprovalResolverCall({
          callIndex: resolveApprovalOverGatewayMock.mock.calls.length - 1,
          method: "exec.approval.resolve",
          id: "abc",
        });
      }
    }
  });
});
