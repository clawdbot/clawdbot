// Line tests cover channel.logout plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveLineAccount } from "./accounts.js";
import { lineGatewayAdapter } from "./gateway.js";
import { setLineRuntime } from "./runtime.js";

const DEFAULT_ACCOUNT_ID = "default";
let tempDir: string;

async function runLogoutScenario(params: { cfg: OpenClawConfig; accountId: string }) {
  const original = structuredClone(params.cfg);
  const runtime = createPluginRuntimeMock();
  setLineRuntime(runtime);
  const result = await lineGatewayAdapter.logoutAccount!({
    accountId: params.accountId,
    cfg: params.cfg,
    account: resolveLineAccount(params),
    runtime: createRuntimeEnv(),
  });
  expect(params.cfg).toEqual(original);
  return { result, mocks: { replaceConfigFile: vi.mocked(runtime.config.replaceConfigFile) } };
}

describe("linePlugin gateway.logoutAccount", () => {
  beforeEach(async () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "");
    vi.stubEnv("LINE_CHANNEL_SECRET", "");
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-line-logout-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clears tokenFile/secretFile on default account logout", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          channelAccessToken: "",
          channelSecret: "",
          tokenFile: path.join(tempDir, "token"),
          secretFile: path.join(tempDir, "secret"),
        },
      },
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      afterWrite: { mode: "auto" },
    });
  });

  it("clears tokenFile/secretFile on account logout", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          accounts: {
            primary: {
              tokenFile: path.join(tempDir, "token"),
              secretFile: path.join(tempDir, "secret"),
            },
          },
        },
      },
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: "primary",
    });

    expect(result.cleared).toBe(true);
    expect(result.loggedOut).toBe(true);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      afterWrite: { mode: "auto" },
    });
  });

  it("does not write config when account has no token/secret fields", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          accounts: {
            primary: {
              name: "Primary",
            },
          },
        },
      },
    };
    const { result, mocks } = await runLogoutScenario({
      cfg,
      accountId: "primary",
    });

    expect(result.cleared).toBe(false);
    expect(result.loggedOut).toBe(true);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("counts empty named credential fields as cleared and preserves sibling config", async () => {
    const sibling = { channelAccessToken: "keep-token", name: "Other" };
    const cfg: OpenClawConfig = {
      channels: {
        line: {
          name: "LINE",
          accounts: {
            primary: {
              channelAccessToken: "",
              channelSecret: "",
              tokenFile: "",
              secretFile: "",
              name: "Primary",
            },
            other: sibling,
          },
        },
        telegram: { enabled: false },
      },
    };
    const { result, mocks } = await runLogoutScenario({ cfg, accountId: "primary" });

    expect(result).toEqual({
      cleared: true,
      envToken: false,
      loggedOut: true,
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledExactlyOnceWith({
      nextConfig: {
        channels: {
          line: {
            name: "LINE",
            accounts: { primary: { name: "Primary" }, other: sibling },
          },
          telegram: { enabled: false },
        },
      },
      afterWrite: { mode: "auto" },
    });
  });
});
