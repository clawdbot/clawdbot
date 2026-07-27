import { z } from "zod";
import { SecretInputSchema } from "./zod-schema.core.js";
import {
  GatewayRemoteConfigSchema,
  ResponsesEndpointUrlFetchShape,
  TailscaleServiceNameSchema,
} from "./zod-schema.root-support.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const GatewayConfigSchema = z
  .strictObject({
    port: z.number().int().min(1).max(65_535).optional(),
    mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
    bind: z
      .union([
        z.literal("auto"),
        z.literal("lan"),
        z.literal("loopback"),
        z.literal("custom"),
        z.literal("tailnet"),
      ])
      .optional(),
    customBindHost: z.string().optional(),
    controlUi: z
      .strictObject({
        // Shipped legacy input. Doctor removes it after recording migration state.
        dangerouslyDisableDeviceAuth: z.boolean().optional(),
        enabled: z.boolean().optional(),
        basePath: z.string().optional(),
        root: z.string().optional(),
        toolTitles: z.boolean().optional(),
        sessionObserver: z.boolean().optional(),
        embedSandbox: z
          .union([z.literal("strict"), z.literal("scripts"), z.literal("trusted")])
          .optional(),
        allowExternalEmbedUrls: z.boolean().optional(),
        allowedOrigins: z.array(z.string()).optional(),
        dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
      })
      .optional(),
    terminal: z
      .strictObject({
        enabled: z.boolean().optional(),
        shell: z.string().optional(),
        detachedSessionTimeoutSeconds: z.number().int().min(0).optional(),
      })
      .optional(),
    auth: z
      .strictObject({
        mode: z
          .union([
            z.literal("none"),
            z.literal("token"),
            z.literal("password"),
            z.literal("trusted-proxy"),
          ])
          .optional(),
        token: SecretInputSchema.optional().register(sensitive),
        password: SecretInputSchema.optional().register(sensitive),
        allowTailscale: z.boolean().optional(),
        rateLimit: z
          .strictObject({
            maxAttempts: z.number().optional(),
            windowMs: z.number().optional(),
            lockoutMs: z.number().optional(),
            exemptLoopback: z.boolean().optional(),
          })
          .optional(),
        trustedProxy: z
          .strictObject({
            userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
            requiredHeaders: z.array(z.string()).optional(),
            allowUsers: z.array(z.string()).optional(),
            allowLoopback: z.boolean().optional(),
            deviceAutoApprove: z
              .strictObject({
                enabled: z.boolean().optional(),
                scopes: z.array(z.string().min(1)).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    trustedProxies: z.array(z.string()).optional(),
    allowRealIpFallback: z.boolean().optional(),
    tools: z
      .strictObject({
        deny: z.array(z.string()).optional(),
        allow: z.array(z.string()).optional(),
      })
      .optional(),
    tailscale: z
      .strictObject({
        mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
        resetOnExit: z.boolean().optional(),
        serviceName: TailscaleServiceNameSchema.optional(),
        preserveFunnel: z.boolean().optional(),
      })
      .optional(),
    remote: GatewayRemoteConfigSchema,
    reload: z
      .strictObject({
        mode: z.union([z.literal("off"), z.literal("hybrid")]).optional(),
      })
      .optional(),
    tls: z
      .object({
        enabled: z.boolean().optional(),
        autoGenerate: z.boolean().optional(),
        // Reject blank values without transforming the string. Trimming here would
        // silently rewrite a legitimate filesystem path that contains leading or
        // trailing spaces and persist the trimmed value into validated config;
        // runtime path resolution (resolveUserPath) owns all normalization.
        certPath: z
          .string()
          .optional()
          .refine((v) => v === undefined || v.trim().length > 0, "certPath must not be blank"),
        keyPath: z
          .string()
          .optional()
          .refine((v) => v === undefined || v.trim().length > 0, "keyPath must not be blank"),
        caPath: z.string().optional(),
      })
      .optional(),
    http: z
      .strictObject({
        endpoints: z
          .strictObject({
            chatCompletions: z
              .strictObject({
                enabled: z.boolean().optional(),
                images: z
                  .strictObject({
                    ...ResponsesEndpointUrlFetchShape,
                  })
                  .optional(),
              })
              .optional(),
            responses: z
              .strictObject({
                enabled: z.boolean().optional(),
                maxUrlParts: z.number().int().nonnegative().optional(),
                files: z
                  .strictObject({
                    ...ResponsesEndpointUrlFetchShape,
                    maxChars: z.number().int().positive().optional(),
                    pdf: z
                      .strictObject({
                        maxPages: z.number().int().positive().optional(),
                        maxPixels: z.number().int().positive().optional(),
                        minTextChars: z.number().int().nonnegative().optional(),
                      })
                      .optional(),
                  })
                  .optional(),
                images: z
                  .strictObject({
                    ...ResponsesEndpointUrlFetchShape,
                  })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
        securityHeaders: z
          .strictObject({
            strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional(),
          })
          .optional(),
      })
      .optional(),
    push: z
      .strictObject({
        apns: z
          .strictObject({
            relay: z
              .strictObject({
                baseUrl: z.string().optional(),
                timeoutMs: z.number().int().positive().optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    nodes: z
      .strictObject({
        browser: z
          .strictObject({
            mode: z.union([z.literal("auto"), z.literal("manual"), z.literal("off")]).optional(),
            node: z.string().optional(),
          })
          .optional(),
        pairing: z
          .strictObject({
            autoApproveCidrs: z.array(z.string()).optional(),
            sshVerify: z
              .union([
                z.boolean(),
                z.strictObject({
                  user: z.string().optional(),
                  identity: z.string().optional(),
                  timeoutMs: z.number().int().positive().optional(),
                  cidrs: z.array(z.string()).optional(),
                }),
              ])
              .optional(),
          })
          .optional(),
        pluginTools: z
          .strictObject({
            enabled: z.boolean().optional(),
          })
          .optional(),
        allowSkills: z.boolean().optional(),
        commands: z
          .strictObject({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();
