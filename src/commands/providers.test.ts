import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStore: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    loadAuthProfileStore: authMocks.loadAuthProfileStore,
  };
});

import {
  formatGatewayProvidersStatusLines,
  providersAddCommand,
  providersListCommand,
  providersRemoveCommand,
} from "./providers.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const baseSnapshot = {
  path: "/tmp/clawdbot.json",
  exists: true,
  raw: "{}",
  parsed: {},
  valid: true,
  config: {},
  issues: [],
  legacyIssues: [],
};

describe("providers command", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.writeConfigFile.mockClear();
    authMocks.loadAuthProfileStore.mockReset();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    authMocks.loadAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
  });

  it("adds a non-default telegram account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseSnapshot });
    await providersAddCommand(
      { provider: "telegram", account: "alerts", token: "123:abc" },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      telegram?: {
        enabled?: boolean;
        accounts?: Record<string, { botToken?: string }>;
      };
    };
    expect(next.telegram?.enabled).toBe(true);
    expect(next.telegram?.accounts?.alerts?.botToken).toBe("123:abc");
  });

  it("adds a default slack account with tokens", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseSnapshot });
    await providersAddCommand(
      {
        provider: "slack",
        account: "default",
        botToken: "xoxb-1",
        appToken: "xapp-1",
      },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      slack?: { enabled?: boolean; botToken?: string; appToken?: string };
    };
    expect(next.slack?.enabled).toBe(true);
    expect(next.slack?.botToken).toBe("xoxb-1");
    expect(next.slack?.appToken).toBe("xapp-1");
  });

  it("deletes a non-default discord account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        discord: {
          accounts: {
            default: { token: "d0" },
            work: { token: "d1" },
          },
        },
      },
    });

    await providersRemoveCommand(
      { provider: "discord", account: "work", delete: true },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      discord?: { accounts?: Record<string, { token?: string }> };
    };
    expect(next.discord?.accounts?.work).toBeUndefined();
    expect(next.discord?.accounts?.default?.token).toBe("d0");
  });

  it("adds a named WhatsApp account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseSnapshot });
    await providersAddCommand(
      { provider: "whatsapp", account: "family", name: "Family Phone" },
      runtime,
      { hasFlags: true },
    );

    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      whatsapp?: { accounts?: Record<string, { name?: string }> };
    };
    expect(next.whatsapp?.accounts?.family?.name).toBe("Family Phone");
  });

  it("adds a second signal account with a distinct name", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        signal: {
          accounts: {
            default: { account: "+15555550111", name: "Primary" },
          },
        },
      },
    });

    await providersAddCommand(
      {
        provider: "signal",
        account: "lab",
        name: "Lab",
        signalNumber: "+15555550123",
      },
      runtime,
      { hasFlags: true },
    );

    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      signal?: {
        accounts?: Record<string, { account?: string; name?: string }>;
      };
    };
    expect(next.signal?.accounts?.lab?.account).toBe("+15555550123");
    expect(next.signal?.accounts?.lab?.name).toBe("Lab");
    expect(next.signal?.accounts?.default?.name).toBe("Primary");
  });

  it("disables a default provider account when remove has no delete flag", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        discord: { token: "d0", enabled: true },
      },
    });

    const prompt = { confirm: vi.fn().mockResolvedValue(true) };
    const prompterModule = await import("../wizard/clack-prompter.js");
    const promptSpy = vi
      .spyOn(prompterModule, "createClackPrompter")
      .mockReturnValue(prompt as never);

    await providersRemoveCommand(
      { provider: "discord", account: "default" },
      runtime,
      { hasFlags: true },
    );

    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      discord?: { enabled?: boolean };
    };
    expect(next.discord?.enabled).toBe(false);
    promptSpy.mockRestore();
  });

  it("includes external auth profiles in JSON output", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {},
    });
    authMocks.loadAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
          access: "token",
          refresh: "refresh",
          expires: 0,
          created: 0,
        },
        "openai-codex:codex-cli": {
          type: "oauth",
          provider: "openai",
          access: "token",
          refresh: "refresh",
          expires: 0,
          created: 0,
        },
      },
    });

    await providersListCommand({ json: true, usage: false }, runtime);
    const payload = JSON.parse(
      String(runtime.log.mock.calls[0]?.[0] ?? "{}"),
    ) as { auth?: Array<{ id: string }> };
    const ids = payload.auth?.map((entry) => entry.id) ?? [];
    expect(ids).toContain("anthropic:claude-cli");
    expect(ids).toContain("openai-codex:codex-cli");
  });

  it("stores default account names in accounts when multiple accounts exist", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        telegram: {
          name: "Legacy Name",
          accounts: {
            work: { botToken: "t0" },
          },
        },
      },
    });

    await providersAddCommand(
      {
        provider: "telegram",
        account: "default",
        token: "123:abc",
        name: "Primary Bot",
      },
      runtime,
      { hasFlags: true },
    );

    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      telegram?: {
        name?: string;
        accounts?: Record<string, { botToken?: string; name?: string }>;
      };
    };
    expect(next.telegram?.name).toBeUndefined();
    expect(next.telegram?.accounts?.default?.name).toBe("Primary Bot");
  });

  it("migrates base names when adding non-default accounts", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseSnapshot,
      config: {
        discord: {
          name: "Primary Bot",
          token: "d0",
        },
      },
    });

    await providersAddCommand(
      { provider: "discord", account: "work", token: "d1" },
      runtime,
      { hasFlags: true },
    );

    const next = configMocks.writeConfigFile.mock.calls[0]?.[0] as {
      discord?: {
        name?: string;
        accounts?: Record<string, { name?: string; token?: string }>;
      };
    };
    expect(next.discord?.name).toBeUndefined();
    expect(next.discord?.accounts?.default?.name).toBe("Primary Bot");
    expect(next.discord?.accounts?.work?.token).toBe("d1");
  });

  it("formats gateway provider status lines in registry order", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        telegram: [{ accountId: "default", configured: true }],
        whatsapp: [{ accountId: "default", linked: true }],
      },
    });

    const telegramIndex = lines.findIndex((line) =>
      line.includes("Telegram default"),
    );
    const whatsappIndex = lines.findIndex((line) =>
      line.includes("WhatsApp default"),
    );
    expect(telegramIndex).toBeGreaterThan(-1);
    expect(whatsappIndex).toBeGreaterThan(-1);
    expect(telegramIndex).toBeLessThan(whatsappIndex);
  });

  it("surfaces Discord privileged intent issues in providers status output", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        discord: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            application: { intents: { messageContent: "disabled" } },
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/Message Content Intent is disabled/i);
    expect(lines.join("\n")).toMatch(/Run: clawdbot doctor/);
  });

  it("surfaces Discord permission audit issues in providers status output", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        discord: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            audit: {
              unresolvedChannels: 1,
              channels: [
                {
                  channelId: "111",
                  ok: false,
                  missing: ["ViewChannel", "SendMessages"],
                },
              ],
            },
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/permission audit/i);
    expect(lines.join("\n")).toMatch(/Channel 111/i);
  });

  it("surfaces Telegram privacy-mode hints when allowUnmentionedGroups is enabled", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        telegram: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            allowUnmentionedGroups: true,
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/Telegram Bot API privacy mode/i);
  });

  it("surfaces Telegram group membership audit issues in providers status output", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        telegram: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            audit: {
              hasWildcardUnmentionedGroups: true,
              unresolvedGroups: 1,
              groups: [
                {
                  chatId: "-1001",
                  ok: false,
                  status: "left",
                  error: "not in group",
                },
              ],
            },
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/membership probing is not possible/i);
    expect(lines.join("\n")).toMatch(/Group -1001/i);
  });

  it("surfaces WhatsApp auth/runtime hints when unlinked or disconnected", () => {
    const unlinked = formatGatewayProvidersStatusLines({
      providerAccounts: {
        whatsapp: [{ accountId: "default", enabled: true, linked: false }],
      },
    });
    expect(unlinked.join("\n")).toMatch(/WhatsApp/i);
    expect(unlinked.join("\n")).toMatch(/Not linked/i);

    const disconnected = formatGatewayProvidersStatusLines({
      providerAccounts: {
        whatsapp: [
          {
            accountId: "default",
            enabled: true,
            linked: true,
            running: true,
            connected: false,
            reconnectAttempts: 5,
            lastError: "connection closed",
          },
        ],
      },
    });
    expect(disconnected.join("\n")).toMatch(/disconnected/i);
  });

  it("surfaces Signal runtime errors in providers status output", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/signal/i);
    expect(lines.join("\n")).toMatch(/Provider error/i);
  });

  it("surfaces iMessage runtime errors in providers status output", () => {
    const lines = formatGatewayProvidersStatusLines({
      providerAccounts: {
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imsg permission denied",
          },
        ],
      },
    });
    expect(lines.join("\n")).toMatch(/Warnings:/);
    expect(lines.join("\n")).toMatch(/imessage/i);
    expect(lines.join("\n")).toMatch(/Provider error/i);
  });
});
