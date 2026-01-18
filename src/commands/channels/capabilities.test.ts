process.env.NO_COLOR = "1";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelPlugin } from "../../channels/plugins/types.js";
import { channelsCapabilitiesCommand } from "./capabilities.js";
import { fetchSlackScopes } from "../../slack/scopes.js";
import { getChannelPlugin, listChannelPlugins } from "../../channels/plugins/index.js";

const logs: string[] = [];
const errors: string[] = [];

vi.mock("./shared.js", () => ({
  requireValidConfig: vi.fn(async () => ({ channels: {} })),
  formatChannelAccountLabel: vi.fn(
    ({ channel, accountId }: { channel: string; accountId: string }) => `${channel}:${accountId}`,
  ),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../slack/scopes.js", () => ({
  fetchSlackScopes: vi.fn(),
}));

const runtime = {
  log: (value: string) => logs.push(value),
  error: (value: string) => errors.push(value),
  exit: (code: number) => {
    throw new Error(`exit:${code}`);
  },
};

function resetOutput() {
  logs.length = 0;
  errors.length = 0;
}

function buildPlugin(params: {
  id: string;
  capabilities?: ChannelPlugin["capabilities"];
  account?: Record<string, unknown>;
  probe?: unknown;
}): ChannelPlugin {
  const capabilities =
    params.capabilities ?? ({ chatTypes: ["direct"] } as ChannelPlugin["capabilities"]);
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: "/channels/test",
      blurb: "test",
    },
    capabilities,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => params.account ?? { accountId: "default" },
      defaultAccountId: () => "default",
      isConfigured: () => true,
      isEnabled: () => true,
    },
    status: params.probe
      ? {
          probeAccount: async () => params.probe,
        }
      : undefined,
    actions: {
      listActions: () => ["poll"],
    },
  };
}

describe("channelsCapabilitiesCommand", () => {
  beforeEach(() => {
    resetOutput();
    vi.clearAllMocks();
  });

  it("prints Slack bot + user scopes when user token is configured", async () => {
    const plugin = buildPlugin({
      id: "slack",
      account: {
        accountId: "default",
        botToken: "xoxb-bot",
        config: { userToken: "xoxp-user" },
      },
      probe: { ok: true, bot: { name: "clawdbot" }, team: { name: "team" } },
    });
    vi.mocked(listChannelPlugins).mockReturnValue([plugin]);
    vi.mocked(getChannelPlugin).mockReturnValue(plugin);
    vi.mocked(fetchSlackScopes).mockImplementation(async (token: string) => {
      if (token === "xoxp-user") {
        return { ok: true, scopes: ["users:read"], source: "auth.scopes" };
      }
      return { ok: true, scopes: ["chat:write"], source: "auth.scopes" };
    });

    await channelsCapabilitiesCommand({ channel: "slack" }, runtime);

    const output = logs.join("\n");
    expect(output).toContain("Bot scopes");
    expect(output).toContain("User scopes");
    expect(output).toContain("chat:write");
    expect(output).toContain("users:read");
    expect(fetchSlackScopes).toHaveBeenCalledWith("xoxb-bot", expect.any(Number));
    expect(fetchSlackScopes).toHaveBeenCalledWith("xoxp-user", expect.any(Number));
  });

  it("prints Teams Graph permission hints when present", async () => {
    const plugin = buildPlugin({
      id: "msteams",
      probe: {
        ok: true,
        appId: "app-id",
        graph: {
          ok: true,
          roles: ["ChannelMessage.Read.All", "Files.Read.All"],
        },
      },
    });
    vi.mocked(listChannelPlugins).mockReturnValue([plugin]);
    vi.mocked(getChannelPlugin).mockReturnValue(plugin);

    await channelsCapabilitiesCommand({ channel: "msteams" }, runtime);

    const output = logs.join("\n");
    expect(output).toContain("ChannelMessage.Read.All (channel history)");
    expect(output).toContain("Files.Read.All (files (OneDrive))");
  });
});
