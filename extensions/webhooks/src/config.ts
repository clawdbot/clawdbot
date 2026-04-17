import { z } from "zod";
import { normalizeWebhookPath } from "../runtime-api.js";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const webhookRouteConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    path: z.string().trim().min(1).optional(),
    sessionKey: z.string().trim().min(1),
    secret: secretInputSchema,
    controllerId: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

const webhooksPluginConfigSchema = z
  .object({
    routes: z.record(z.string().trim().min(1), webhookRouteConfigSchema).default({}),
  })
  .strict();

export type WebhookSecretInput = z.infer<typeof secretInputSchema>;

export type ConfiguredWebhookRouteConfig = {
  routeId: string;
  path: string;
  sessionKey: string;
  secret: WebhookSecretInput;
  controllerId: string;
  description?: string;
};

export function resolveWebhooksPluginConfig(params: {
  pluginConfig: unknown;
}): ConfiguredWebhookRouteConfig[] {
  const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
  const configuredRoutes: ConfiguredWebhookRouteConfig[] = [];
  const seenPaths = new Map<string, string>();

  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (!route.enabled) {
      continue;
    }
    const path = normalizeWebhookPath(route.path ?? `/plugins/webhooks/${routeId}`);
    const existingRouteId = seenPaths.get(path);
    if (existingRouteId) {
      throw new Error(
        `webhooks.routes.${routeId}.path conflicts with routes.${existingRouteId}.path (${path}).`,
      );
    }

    seenPaths.set(path, routeId);
    configuredRoutes.push({
      routeId,
      path,
      sessionKey: route.sessionKey,
      secret: route.secret,
      controllerId: route.controllerId ?? `webhooks/${routeId}`,
      ...(route.description ? { description: route.description } : {}),
    });
  }

  return configuredRoutes;
}
