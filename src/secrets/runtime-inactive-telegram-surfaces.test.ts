import { describe, expect, it } from "vitest";
import "./runtime-telegram.test-support.ts";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot inactive telegram surfaces", () => {
  it("skips inactive Telegram refs and emits diagnostics", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          telegram: {
            botToken: { source: "env", provider: "default", id: "DISABLED_TELEGRAM_BASE_TOKEN" },
            accounts: {
              disabled: {
                enabled: false,
                botToken: {
                  source: "env",
                  provider: "default",
                  id: "DISABLED_TELEGRAM_ACCOUNT_TOKEN",
                },
              },
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.channels?.telegram?.botToken).toEqual({
      source: "env",
      provider: "default",
      id: "DISABLED_TELEGRAM_BASE_TOKEN",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "channels.telegram.botToken",
        "channels.telegram.accounts.disabled.botToken",
      ]),
    );
  });
});
