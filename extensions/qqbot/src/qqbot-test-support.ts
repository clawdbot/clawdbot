import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export function makeQqbotSecretRefConfig(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "123456",
        clientSecret: {
          source: "env",
          provider: "default",
          id: "QQBOT_CLIENT_SECRET",
        },
      },
    },
  } as OpenClawConfig;
}

export function makeQqbotDefaultAccountConfig(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        defaultAccount: "bot2",
        accounts: {
          bot2: { appId: "123456" },
        },
      },
    },
  } as OpenClawConfig;
}
