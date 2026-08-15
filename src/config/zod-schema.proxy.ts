// Defines proxy-related Zod schema fragments for config parsing.
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

const ProxyLoopbackModeSchema = z.enum(["gateway-only", "proxy", "block"]);

const ProxyTlsConfigSchema = z
  .object({
    caFile: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const ProxyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .url()
      .refine(isHttpUrl, {
        message: "proxyUrl must use http:// or https://",
      })
      .register(sensitive)
      .optional(),
    tls: ProxyTlsConfigSchema,
    loopbackMode: ProxyLoopbackModeSchema.optional(),
  })
  .strict()
  .optional();

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
