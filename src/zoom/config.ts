import { z } from "zod";
import type { MoltbotConfig } from "../config/config.js";

export const ZoomConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  botJid: z.string().optional(),
  secretToken: z.string().optional(),
  apiHost: z.string().optional(),
  oauthHost: z.string().optional(),
  dm: z
    .object({
      policy: z.enum(["open", "allowlist", "pairing"]).optional(),
      allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    })
    .optional(),
});

export type ZoomConfig = z.infer<typeof ZoomConfigSchema>;

export type ResolvedZoomAccount = {
  accountId: string;
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  botJid?: string;
  secretToken?: string;
  apiHost: string;
  oauthHost: string;
  config: ZoomConfig;
};

export function resolveZoomAccount(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): ResolvedZoomAccount {
  const { cfg } = params;
  const zoomConfig = (cfg.channels as any)?.zoom as ZoomConfig | undefined;
  const config = zoomConfig ?? {};

  return {
    accountId: "default",
    enabled: config.enabled ?? true,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    botJid: config.botJid,
    secretToken: config.secretToken,
    apiHost: config.apiHost || "https://api.zoom.us",
    oauthHost: config.oauthHost || "https://zoom.us",
    config,
  };
}
