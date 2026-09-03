// Doctor default-account integration tests cover binding warnings across realistic config shapes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  collectMissingDefaultAccountBindingWarnings,
  collectMissingExplicitDefaultAccountWarnings,
} from "./doctor/shared/default-account-warnings.js";
import { repairUnownedChannelAccountBindings } from "./doctor/shared/legacy-config-binding-repair.js";

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: () => {
    const { listAccountIds } = createAccountListHelpers("discord", {
      implicitDefaultAccount: { channelKeys: ["token"], envVars: ["DISCORD_BOT_TOKEN"] },
    });
    return {
      configuredChannelIds: ["discord"],
      plugins: [{ id: "discord", config: { listAccountIds } }],
    };
  },
}));

describe("doctor missing default account binding warning", () => {
  it("warns when named accounts have no valid account-scoped bindings", () => {
    const warnings = collectMissingDefaultAccountBindingWarnings({
      channels: {
        telegram: {
          accounts: {
            alerts: {},
            work: {},
          },
        },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
    } as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.telegram: accounts.default is missing and no valid account-scoped binding exists for configured accounts (alerts, work). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add channels.telegram.accounts.default.',
    ]);
  });

  it("warns when multiple accounts have no explicit default", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          accounts: {
            alerts: {},
            work: {},
          },
        },
      },
    } as OpenClawConfig);

    expect(warnings).toEqual([
      "- channels.telegram: multiple accounts are configured but no explicit default is set. Set channels.telegram.defaultAccount or add channels.telegram.accounts.default to avoid fallback routing.",
    ]);
  });

  it("warns when defaultAccount does not match configured accounts", () => {
    const warnings = collectMissingExplicitDefaultAccountWarnings({
      channels: {
        telegram: {
          defaultAccount: "missing",
          accounts: {
            alerts: {},
            work: {},
          },
        },
      },
    } as OpenClawConfig);

    expect(warnings).toEqual([
      '- channels.telegram: defaultAccount is set to "missing" but does not match configured accounts (alerts, work). Set channels.telegram.defaultAccount to one of these accounts, or add channels.telegram.accounts.default to avoid fallback routing.',
    ]);
  });
});

type OwnershipRepairCase = {
  name: string;
  agents?: OpenClawConfig["agents"];
  envToken?: boolean;
  discord: NonNullable<OpenClawConfig["channels"]>["discord"];
  bindings: NonNullable<OpenClawConfig["bindings"]>;
  added: NonNullable<OpenClawConfig["bindings"]>;
};

describe("doctor channel account ownership repair", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each<OwnershipRepairCase>([
    {
      name: "implicit default account",
      discord: {},
      bindings: [{ agentId: "ops", match: { channel: "discord", guildId: "guild-a" } }],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "default" } }],
    },
    {
      name: "named account without widening other account or guild owners",
      discord: { accounts: { alerts: {}, work: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "alerts", guildId: "guild-a" } },
        { agentId: "ops", match: { channel: "discord", accountId: "alerts", guildId: "guild-b" } },
        { agentId: "research", match: { channel: "discord", accountId: "work" } },
      ],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "alerts" } }],
    },
    {
      name: "environment-only default account alongside a named account",
      envToken: true,
      discord: { accounts: { alerts: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "*", guildId: "guild-a" } },
      ],
      added: [
        { agentId: "ops", match: { channel: "discord", accountId: "alerts" } },
        { agentId: "ops", match: { channel: "discord", accountId: "default" } },
      ],
    },
    {
      name: "root-token default account alongside a named account",
      discord: { token: "synthetic-discord-token", accounts: { alerts: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "*", guildId: "guild-a" } },
      ],
      added: [
        { agentId: "ops", match: { channel: "discord", accountId: "alerts" } },
        { agentId: "ops", match: { channel: "discord", accountId: "default" } },
      ],
    },
    {
      name: "narrow wildcard ownership without inventing a default account",
      discord: { accounts: { alerts: {}, work: { enabled: false } } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "*", guildId: "guild-a" } },
      ],
      added: [{ agentId: "ops", match: { channel: "discord", accountId: "alerts" } }],
    },
    {
      name: "disabled default account alongside an active account",
      discord: { accounts: { default: { enabled: false }, work: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
        {
          agentId: "research",
          match: { channel: "discord", accountId: "work", guildId: "guild-b" },
        },
      ],
      added: [{ agentId: "research", match: { channel: "discord", accountId: "work" } }],
    },
    {
      name: "disabled channel",
      discord: { enabled: false },
      bindings: [{ agentId: "ops", match: { channel: "discord", guildId: "guild-a" } }],
      added: [],
    },
    {
      name: "unconfigured legacy main owner",
      discord: {},
      bindings: [{ agentId: "main", match: { channel: "discord", guildId: "guild-a" } }],
      added: [],
    },
    {
      name: "blank owner even when main is configured",
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      discord: {},
      bindings: [{ agentId: "   ", match: { channel: "discord", guildId: "guild-a" } }],
      added: [],
    },
    {
      name: "empty peer that cannot match a route",
      discord: {},
      bindings: [
        { agentId: "ops", match: { channel: "discord", peer: { kind: "direct", id: " " } } },
      ],
      added: [],
    },
    {
      name: "ambiguous guild owners",
      discord: {},
      bindings: [
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
        { agentId: "research", match: { channel: "discord", guildId: "guild-b" } },
      ],
      added: [],
    },
    {
      name: "missing owner despite bindings on another account and channel",
      discord: { accounts: { default: {}, work: {} } },
      bindings: [
        { agentId: "ops", match: { channel: "discord", accountId: "work" } },
        { agentId: "ops", match: { channel: "telegram", accountId: "default" } },
      ],
      added: [],
    },
    {
      name: "existing channel-wide route",
      discord: { accounts: { default: {}, work: {} } },
      bindings: [
        { agentId: "research", match: { channel: "discord", accountId: "*" } },
        { agentId: "ops", match: { channel: "discord", guildId: "guild-a" } },
      ],
      added: [],
    },
  ])("repairs only proven ownership for $name", (testCase) => {
    const { discord, bindings, added } = testCase;
    vi.stubEnv(
      "DISCORD_BOT_TOKEN",
      "envToken" in testCase && testCase.envToken ? "synthetic-discord-token" : undefined,
    );
    const config: OpenClawConfig = {
      agents: testCase.agents ?? { ownership: "explicit", entries: { ops: {}, research: {} } },
      channels: { discord },
      bindings,
    };
    const repaired = repairUnownedChannelAccountBindings(config);
    expect(repaired.config.bindings).toEqual([...bindings, ...added]);
    for (const binding of added) {
      expect(resolveAgentRoute({ cfg: repaired.config, ...binding.match }).agentId).toBe(
        binding.agentId,
      );
    }
    const secondPass = repairUnownedChannelAccountBindings(repaired.config);
    expect(secondPass.config).toBe(repaired.config);
    expect(secondPass.changes).toEqual([]);
  });
});
