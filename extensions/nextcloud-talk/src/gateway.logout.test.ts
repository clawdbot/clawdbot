import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { nextcloudTalkGatewayAdapter } from "./gateway.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

let tempDir: string;

beforeEach(async () => {
  vi.stubEnv("NEXTCLOUD_TALK_BOT_SECRET", "");
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nextcloud-logout-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function logout(cfg: OpenClawConfig & CoreConfig, accountId: string) {
  const original = structuredClone(cfg);
  const runtime = createPluginRuntimeMock();
  setNextcloudTalkRuntime(runtime);
  const result = await nextcloudTalkGatewayAdapter.logoutAccount!({
    cfg,
    accountId,
    account: resolveNextcloudTalkAccount({ cfg, accountId }),
    runtime: createRuntimeEnv(),
  });
  expect(cfg).toEqual(original);
  return { result, write: vi.mocked(runtime.config.replaceConfigFile) };
}

describe("Nextcloud Talk logout", () => {
  it.each(["default", "primary"])(
    "preserves file credentials and other accounts for %s",
    async (accountId) => {
      const remaining = {
        baseUrl: "https://cloud.example.com",
        botSecretFile: path.join(tempDir, "secret"),
        apiUser: "api-user",
        apiPassword: "api-password",
        apiPasswordFile: path.join(tempDir, "api-password"),
        name: "Keep",
      };
      const account = { ...remaining, botSecret: "remove" };
      const other = { botSecret: "keep", name: "Other" };
      const cfg: OpenClawConfig & CoreConfig = {
        channels: {
          "nextcloud-talk":
            accountId === "default"
              ? { ...account, accounts: { other } }
              : { accounts: { primary: account, other } },
          telegram: { enabled: false },
        },
      };
      const { result, write } = await logout(cfg, accountId);
      expect(result).toEqual({ cleared: true, envSecret: false, loggedOut: false });
      expect(write).toHaveBeenCalledExactlyOnceWith({
        nextConfig: {
          channels: {
            "nextcloud-talk":
              accountId === "default"
                ? { ...remaining, accounts: { other } }
                : { accounts: { primary: remaining, other } },
            telegram: { enabled: false },
          },
        },
        afterWrite: { mode: "auto" },
      });
    },
  );
});
