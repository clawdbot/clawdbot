import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString as readNonEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordActivitiesConfigResolution =
  | {
      enabled: true;
      clientSecret: string;
      applicationId?: string;
    }
  | {
      enabled: false;
      reason: "not-configured" | "missing-client-secret";
    };

export function resolveDiscordActivitiesConfig(
  account: DiscordAccountConfig,
  env: NodeJS.ProcessEnv = process.env,
): DiscordActivitiesConfigResolution {
  if (!account.activities) {
    return { enabled: false, reason: "not-configured" };
  }
  const clientSecret =
    readNonEmpty(account.activities.clientSecret) ?? readNonEmpty(env.DISCORD_CLIENT_SECRET);
  if (!clientSecret) {
    return { enabled: false, reason: "missing-client-secret" };
  }
  const applicationId = readNonEmpty(account.activities.applicationId);
  return {
    enabled: true,
    clientSecret,
    ...(applicationId ? { applicationId } : {}),
  };
}
