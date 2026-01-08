import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
    writeConfigFile: configMocks.writeConfigFile,
  };
});

import { providersAddCommand, providersRemoveCommand } from "./providers.js";

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
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
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
});
