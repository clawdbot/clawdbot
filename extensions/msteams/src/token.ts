import type { MSTeamsConfig } from "clawdbot/plugin-sdk";

export type MSTeamsCredentials = {
  appId: string;
  appPassword: string;
  tenantId: string;
};

export function resolveMSTeamsCredentials(cfg?: MSTeamsConfig): MSTeamsCredentials | undefined {
  const appId = cfg?.appId?.trim() || process.env.MSTEAMS_APP_ID?.trim();
  const appPassword = cfg?.appPassword?.trim() || process.env.MSTEAMS_APP_PASSWORD?.trim();
  const tenantId = cfg?.tenantId?.trim() || process.env.MSTEAMS_TENANT_ID?.trim();

  if (!appId || !appPassword || !tenantId) {
    return undefined;
  }

  return { appId, appPassword, tenantId };
}
