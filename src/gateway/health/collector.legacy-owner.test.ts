import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: ChannelPlugin[] = [];

let collectGatewayHealthSnapshot: typeof import("./collector.js").collectGatewayHealthSnapshot;
let createChannelTestPluginBase: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;

function createHealthPlugin(): ChannelPlugin {
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null) => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  return {
    ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
    config: {
      listAccountIds: (cfg) => {
        const telegram = cfg.channels?.telegram as
          | { accounts?: Record<string, unknown> }
          | undefined;
        const accountIds = Object.keys(telegram?.accounts ?? {});
        return accountIds.length > 0 ? accountIds : ["default"];
      },
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
    },
    status: {
      buildChannelSummary: ({ snapshot }) => ({
        accountId: snapshot.accountId,
        configured: snapshot.configured,
      }),
    },
  };
}

describe("collectGatewayHealthSnapshot legacy owner projection", () => {
  beforeAll(async () => {
    vi.doMock("../../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
    }));
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => "/tmp/sessions.json",
    }));
    vi.doMock("../../config/sessions/session-accessor.js", () => ({
      listSessionEntriesReadOnly: () => [],
    }));
    vi.doMock("../../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
    }));

    const [health, channelTestUtils] = await Promise.all([
      import("./collector.js"),
      import("../../test-utils/channel-plugins.js"),
    ]);
    collectGatewayHealthSnapshot = health.collectGatewayHealthSnapshot;
    createChannelTestPluginBase = channelTestUtils.createChannelTestPluginBase;
  });

  beforeEach(() => {
    healthPluginsForTest = [createHealthPlugin()];
  });

  it("projects the retained owner without inventing an explicit fleet default", async () => {
    const migratedConfig = {
      agents: {
        entries: { first: {}, ops: {}, research: {} },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "ops" } }],
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "default-token" },
            ops: { botToken: "ops-token" },
          },
        },
      },
    } satisfies OpenClawConfig;
    testConfig = retainLegacyDefaultAgentId(migratedConfig, "ops");

    const migrated = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(migrated.defaultAgentId).toBe("ops");
    const migratedOwner = migrated.agents.find((agent) => agent.isDefault);
    expect(migratedOwner?.agentId).toBe("ops");
    expect(migratedOwner?.heartbeat.enabled).toBe(true);
    expect(migrated.agents.find((agent) => agent.agentId === "first")?.heartbeat.enabled).toBe(
      false,
    );
    expect(migrated.heartbeatSeconds).toBe((migratedOwner?.heartbeat.everyMs ?? 0) / 1000);
    expect(migrated.channels.telegram?.accountId).toBe("ops");

    testConfig = {
      agents: {
        ownership: "explicit",
        entries: { first: {}, ops: {}, research: {} },
      },
    };

    const explicit = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(explicit.defaultAgentId).toBeUndefined();
    expect(explicit.agents.every((agent) => !agent.isDefault)).toBe(true);
    expect(explicit.agents.every((agent) => !agent.heartbeat.enabled)).toBe(true);
  });

  it("projects the configured heartbeat owner's cadence", async () => {
    testConfig = {
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { agentId: "research", every: "30m" } },
        entries: {
          ops: {},
          research: { heartbeat: { every: "5m" } },
        },
      },
    };

    const health = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(health.agents.map((agent) => agent.agentId)).toEqual(["ops", "research"]);
    expect(health.agents.find((agent) => agent.agentId === "research")?.heartbeat.enabled).toBe(
      true,
    );
    expect(health.heartbeatSeconds).toBe(5 * 60);
  });
});
