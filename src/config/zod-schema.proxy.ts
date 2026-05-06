import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

function isHttpProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:";
  } catch {
    return false;
  }
}

export const ProxyLoopbackModeSchema = z.enum(["gateway-only", "proxy", "block"]);

export const ProxyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .url()
      .refine(isHttpProxyUrl, {
        message: "proxyUrl must use http://",
      })
      .register(sensitive)
      .optional(),
    loopbackMode: ProxyLoopbackModeSchema.optional(),
  })
  .strict()
  .optional();

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
