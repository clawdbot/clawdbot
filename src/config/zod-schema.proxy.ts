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

export const ProxyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .string()
      .url()
      .refine(isHttpProxyUrl, {
        message: "proxyUrl must use http://",
      })
      .register(sensitive)
      .optional(),
  })
  .strict()
  .optional();

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
