import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { MsgContext } from "../templating.js";
import { resolvePrivateCommandRouteTargets } from "./commands-private-route.js";
import type { HandleCommandsParams } from "./commands-types.js";

function createApprovalChannelPlugin(params: {
  id: "discord" | "telegram" | "whatsapp";
  targets: Array<{ to: string; threadId?: string | number | null }>;
  enabled?: boolean;
}): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.id,
    }),
    approvalCapability: {
      native: {
        describeDeliveryCapabilities: vi.fn(() => ({
          enabled: params.enabled !== false,
          preferredSurface: "approver-dm" as const,
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        })),
        resolveApproverDmTargets: vi.fn(() => params.targets),
      },
    },
  };
}

function createOwnerDerivedApprovalChannelPlugin(params: {
  id: "telegram";
  ownerPrefixes: string[];
}): ChannelPlugin {
  const resolveOwnerTargets = (cfg: OpenClawConfig) =>
    (cfg.commands?.ownerAllowFrom ?? [])
      .map((owner) => String(owner))
      .flatMap((owner) => {
        const trimmed = owner.trim();
        const prefix = params.ownerPrefixes.find((candidate) =>
          trimmed.toLowerCase().startsWith(`${candidate}:`),
        );
        if (prefix) {
          const value = trimmed.slice(prefix.length + 1).trim();
          return value ? [value] : [];
        }
        return /^\d+$/.test(trimmed) ? [trimmed] : [];
      })
      .map((to) => ({ to }));

  return {
    ...createChannelTestPluginBase({
      id: params.id,
      label: params.id,
    }),
    approvalCapability: {
      native: {
        describeDeliveryCapabilities: vi.fn(({ cfg }) => {
          const targets = resolveOwnerTargets(cfg);
          return {
            enabled: targets.length > 0,
            preferredSurface: "approver-dm" as const,
            supportsOriginSurface: false,
            supportsApproverDmSurface: true,
          };
        }),
        resolveApproverDmTargets: vi.fn(({ cfg }) => resolveOwnerTargets(cfg)),
      },
    },
  };
}

function registerApprovalChannelPlugins(plugins: ChannelPlugin[]) {
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((plugin) => ({
        pluginId: plugin.id,
        source: "test",
        plugin,
      })),
    ),
  );
}

function buildCommandParams(cfg: OpenClawConfig): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "discord",
      Surface: "discord",
      AccountId: "discord-bot-account",
    } as MsgContext,
    command: {
      commandBodyNormalized: "/diagnostics",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "493655423946194964",
      channel: "discord",
      channelId: "discord",
      surface: "discord",
      ownerList: [],
      rawBodyNormalized: "/diagnostics",
      from: "493655423946194964",
      to: "channel:1487138064806449297",
    },
    sessionKey: "agent:main:discord:channel:1487138064806449297",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: true,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

function buildApprovalRequest(): ExecApprovalRequest {
  return {
    id: "diagnostics-private-route",
    request: {
      command: "openclaw gateway diagnostics export --json",
      sessionKey: "agent:main:discord:channel:1487138064806449297",
      turnSourceChannel: "discord",
      turnSourceTo: "channel:1487138064806449297",
      turnSourceAccountId: "discord-bot-account",
    },
    createdAtMs: 1,
    expiresAtMs: 60_001,
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("resolvePrivateCommandRouteTargets", () => {
  it("prefers a same-surface private owner route even when another owner route is listed first", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "telegram",
        targets: [{ to: "849985193" }],
      }),
      createApprovalChannelPlugin({
        id: "discord",
        targets: [{ to: "493655423946194964" }],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: ["telegram:849985193", "discord:493655423946194964"],
        },
      } as OpenClawConfig),
      request: buildApprovalRequest(),
    });

    expect(targets[0]).toEqual({
      channel: "discord",
      to: "493655423946194964",
      accountId: "discord-bot-account",
      threadId: undefined,
    });
    expect(targets[1]).toEqual({
      channel: "telegram",
      to: "849985193",
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("falls back to the first configured owner route when the source surface has no private route", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "discord",
        targets: [],
      }),
      createApprovalChannelPlugin({
        id: "whatsapp",
        targets: [{ to: "+15555550100" }],
      }),
      createApprovalChannelPlugin({
        id: "telegram",
        targets: [{ to: "849985193" }],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: [
            "discord:493655423946194964",
            "telegram:849985193",
            "whatsapp:+15555550100",
          ],
        },
      } as OpenClawConfig),
      request: buildApprovalRequest(),
    });

    expect(targets[0]?.channel).toBe("telegram");
    expect(targets[0]?.to).toBe("849985193");
    expect(targets[1]?.channel).toBe("whatsapp");
    expect(targets[1]?.to).toBe("+15555550100");
  });

  it("does not select a same-surface exec approver unless it is also an owner route", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "discord",
        targets: [{ to: "non-owner-approver" }],
      }),
      createApprovalChannelPlugin({
        id: "telegram",
        targets: [{ to: "849985193" }],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: ["telegram:849985193"],
        },
      } as OpenClawConfig),
      request: buildApprovalRequest(),
    });

    expect(targets).toEqual([
      {
        channel: "telegram",
        to: "849985193",
        accountId: undefined,
        threadId: undefined,
      },
    ]);
  });

  it("routes a Discord group command to the Telegram owner without Telegram exec approvers", async () => {
    registerApprovalChannelPlugins([
      createApprovalChannelPlugin({
        id: "discord",
        targets: [],
      }),
      createOwnerDerivedApprovalChannelPlugin({
        id: "telegram",
        ownerPrefixes: ["telegram", "tg"],
      }),
    ]);

    const targets = await resolvePrivateCommandRouteTargets({
      commandParams: buildCommandParams({
        commands: {
          ownerAllowFrom: ["telegram:849985193"],
        },
        channels: {
          telegram: {
            botToken: "test-token",
          },
        },
      } as OpenClawConfig),
      request: buildApprovalRequest(),
    });

    expect(targets).toEqual([
      {
        channel: "telegram",
        to: "849985193",
        accountId: undefined,
        threadId: undefined,
      },
    ]);
  });
});
