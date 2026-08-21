import { MAX_TCP_PORT } from "openclaw/plugin-sdk/number-runtime";
import { z } from "zod";

export const VoiceCallTailscaleConfigSchema = z
  .object({
    mode: z.enum(["off", "serve", "funnel"]).default("off"),
    port: z.number().int().positive().max(MAX_TCP_PORT).default(443),
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ mode: "off", port: 443, path: "/voice/webhook" });

const TAILSCALE_FUNNEL_HTTPS_PORTS = new Set([443, 8443, 10000]);

export function isTailscalePortAllowed(config: {
  tailscale: z.infer<typeof VoiceCallTailscaleConfigSchema>;
  tunnel: { provider: string };
}): boolean {
  const usesFunnel =
    config.tailscale.mode === "funnel" || config.tunnel.provider === "tailscale-funnel";
  return !usesFunnel || TAILSCALE_FUNNEL_HTTPS_PORTS.has(config.tailscale.port);
}
