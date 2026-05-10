import { describe, expect, it } from "vitest";
import "./runtime-telegram.test-support.ts";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function expectWarningPaths(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
  expectedPaths: string[],
): void {
  const warningPaths = new Set(snapshot.warnings.map((warning) => warning.path));
  for (const expectedPath of expectedPaths) {
    expect(warningPaths.has(expectedPath)).toBe(true);
  }
}

function requireTelegramConfig(
  snapshot: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>,
) {
  const config = snapshot.config.channels?.telegram;
  if (!config) {
    throw new Error("expected Telegram runtime config");
  }
  return config;
}

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

    expect(requireTelegramConfig(snapshot).botToken).toEqual({
      source: "env",
      provider: "default",
      id: "DISABLED_TELEGRAM_BASE_TOKEN",
    });
    expectWarningPaths(snapshot, [
      "channels.telegram.botToken",
      "channels.telegram.accounts.disabled.botToken",
    ]);
  });
});
