import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLineAccountIds } from "./accounts.js";
import { lineConfigAdapter } from "./config-adapter.js";

describe("LINE config adapter", () => {
  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears default account credentials while preserving named accounts", () => {
    const cfg = {
      channels: {
        line: {
          channelAccessToken: "default-token",
          channelSecret: "default-secret",
          tokenFile: "/tmp/default-token",
          secretFile: "/tmp/default-secret",
          name: "Default LINE",
          accounts: {
            alerts: {
              channelAccessToken: "alerts-token",
              channelSecret: "alerts-secret",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const nextCfg = lineConfigAdapter.deleteAccount!({ cfg, accountId: "default" });

    expect(nextCfg.channels?.line).toMatchObject({
      accounts: {
        alerts: {
          channelAccessToken: "alerts-token",
          channelSecret: "alerts-secret",
        },
      },
    });
    expect(nextCfg.channels?.line?.channelAccessToken).toBeUndefined();
    expect(nextCfg.channels?.line?.channelSecret).toBeUndefined();
    expect(nextCfg.channels?.line?.tokenFile).toBeUndefined();
    expect(nextCfg.channels?.line?.secretFile).toBeUndefined();
    expect(nextCfg.channels?.line?.name).toBeUndefined();
    expect(listLineAccountIds(nextCfg)).toEqual(["alerts"]);
  });
});
