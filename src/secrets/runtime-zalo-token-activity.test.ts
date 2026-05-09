import { describe, expect, it } from "vitest";
import "./runtime-zalo.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function requireZaloConfig(snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>) {
  const config = snapshot.config.channels?.zalo;
  if (!config) {
    throw new Error("expected Zalo runtime config");
  }
  return config;
}

describe("secrets runtime snapshot zalo token activity", () => {
  it("treats top-level Zalo botToken refs as active even when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            botToken: { source: "env", provider: "default", id: "ZALO_BOT_TOKEN" },
            tokenFile: "/tmp/missing-zalo-token-file",
          },
        },
      }),
      env: {
        ZALO_BOT_TOKEN: "resolved-zalo-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(requireZaloConfig(snapshot).botToken).toBe("resolved-zalo-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.botToken",
    );
  });

  it("treats account-level Zalo botToken refs as active even when tokenFile is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              work: {
                botToken: { source: "env", provider: "default", id: "ZALO_WORK_BOT_TOKEN" },
                tokenFile: "/tmp/missing-zalo-work-token-file",
              },
            },
          },
        },
      }),
      env: {
        ZALO_WORK_BOT_TOKEN: "resolved-zalo-work-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.zalo?.accounts?.work as { botToken?: unknown } | undefined)
        ?.botToken,
    ).toBe("resolved-zalo-work-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.accounts.work.botToken",
    );
  });

  it("treats top-level Zalo botToken refs as active for non-default accounts without overrides", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            botToken: { source: "env", provider: "default", id: "ZALO_TOP_LEVEL_TOKEN" },
            accounts: {
              work: {
                enabled: true,
              },
            },
          },
        },
      }),
      env: {
        ZALO_TOP_LEVEL_TOKEN: "resolved-zalo-top-level-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(requireZaloConfig(snapshot).botToken).toBe("resolved-zalo-top-level-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.botToken",
    );
  });

  it("treats channels.zalo.accounts.default.botToken refs as active", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          zalo: {
            accounts: {
              default: {
                enabled: true,
                botToken: { source: "env", provider: "default", id: "ZALO_DEFAULT_TOKEN" },
              },
            },
          },
        },
      }),
      env: {
        ZALO_DEFAULT_TOKEN: "resolved-zalo-default-token",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(
      (snapshot.config.channels?.zalo?.accounts?.default as { botToken?: unknown } | undefined)
        ?.botToken,
    ).toBe("resolved-zalo-default-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.zalo.accounts.default.botToken",
    );
  });
});
